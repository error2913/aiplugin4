// 观察巩固：pending facts → 观察（evidence / proofCount / history）。
// 不物理删除过期观察；不在本层调用 LLM 之外的副作用。
import { isClassifiedApiError } from "../../model/api_error";
import { generateId } from "../../utils/id";

import type { MemoryRepository } from "./repository";
import { distinctLiveEvidence } from "./repository";
import { sameCluster, textSimilarity } from "./scoring";
import type {
    ConsolidateOutcome,
    MemoryUnit,
    Observation,
    ObservationDecision,
    ObservationDecisionBatchMaker,
    ObservationDecisionInput,
    ObservationDecisionMaker,
} from "./types";

/** P0-1：一次请求最多判定多少个 cluster（写死，与单次巩固 20 条对齐 → 1 job = 1 call） */
const OBSERVATION_DECISION_BATCH_SIZE = 20;

export interface ConsolidationHost {
    repository: MemoryRepository;
    decideObservation?: ObservationDecisionMaker;
    decideObservationBatch?: ObservationDecisionBatchMaker;
    synthesizeObservation?: (quotes: string[]) => Promise<string>;
}

export async function doConsolidate(
    host: ConsolidationHost,
    bankId: string,
    opts: { maxFacts?: number; targetedTags?: string[] } = {},
): Promise<ConsolidateOutcome> {
    const repo = host.repository;
    const bank = repo.getBank(bankId);
    const empty: ConsolidateOutcome = { created: [], updated: [], merged: [], skipped: 0, touchedTags: [], pendingRemaining: 0 };
    if (!bank) return empty;

    const limit = opts.maxFacts ?? 50;
    const all = repo.listPendingFacts(bankId, Infinity);
    const scoped = opts.targetedTags && opts.targetedTags.length
        ? (() => { const scope = new Set(opts.targetedTags); return all.filter(f => f.tags.some(t => scope.has(t))); })()
        : all;
    const pending = pickPending(scoped, limit);
    if (pending.length === 0) return { ...empty, pendingRemaining: countPending(bank.units) };

    const clusters = clusterFacts(pending);
    const created: string[] = [];
    const updated: string[] = [];
    const merged: string[] = [];
    const touched = new Set<string>();
    const processed: string[] = [];

    const applyCluster = (cluster: MemoryUnit[], decision: ObservationDecision): void => {
        applyDecision(host, bankId, cluster, decision, { created, updated, merged });
        for (const fact of cluster) {
            touched.add(fact.tags.find(t => /^(user|group|global):/.test(t)) || '');
            processed.push(fact.id);
        }
    };

    try {
        for (let start = 0; start < clusters.length; start += OBSERVATION_DECISION_BATCH_SIZE) {
            const batch = clusters.slice(start, start + OBSERVATION_DECISION_BATCH_SIZE);
            const inputs: ObservationDecisionInput[] = batch.map(cluster => ({
                evidence: cluster.map(f => f.text),
                existing: findRelatedObservations(bank.observations, cluster),
                tags: unionTags(cluster),
            }));

            let decisions: Array<ObservationDecision | null> = batch.map(() => null);
            if (host.decideObservationBatch) {
                try {
                    const out = await host.decideObservationBatch(inputs);
                    decisions = batch.map((_, i) => out[i] ?? null);
                } catch (e) {
                    // 任何分类 API 错误整批上抛：限流时逐条重发 = 1→N 连发
                    if (isClassifiedApiError(e)) throw e;
                    decisions = batch.map(() => null);
                }
            }

            for (let i = 0; i < batch.length; i++) {
                const input = inputs[i];
                let raw: ObservationDecision | null = decisions[i] ?? null;
                if (!raw && host.decideObservation) {
                    raw = await host.decideObservation(input);   // 只补缺失项；抛错则上抛
                }
                const decision = raw
                    ? normalizeDecision(raw, batch[i], input.existing)
                    : { action: 'create' as const, evidenceMemoryIds: batch[i].map(f => f.id) };
                applyCluster(batch[i], decision);
            }
        }
    } finally {
        // 任何异常中途中断，都要把已判定的 cluster 落盘，避免「观察已建、事实仍 pending」
        try {
            if (processed.length) {
                repo.markConsolidated(bankId, processed);
                const now = Math.floor(Date.now() / 1000);
                const meta = repo.getBankMeta(bankId);
                if (meta) {
                    meta.settings.lastConsolidateAt = now;
                    repo.setPendingCount(bankId);
                }
                repo.save(bankId, ['units', 'obs', 'meta']);
            }
        } catch { /* 不得掩盖原异常 */ }
    }

    return {
        created,
        updated,
        merged,
        skipped: pending.length - processed.length,
        touchedTags: Array.from(touched).filter(Boolean),
        pendingRemaining: repo.listUnits(bankId).filter(u => u.state === 'valid' && u.consolidationState === 'pending').length,
    };
}

const DECISION_ACTIONS = new Set(['create', 'reinforce', 'refine', 'contradict', 'merge', 'noop']);

/**
 * cluster 级校验：targetId 必须属于本 cluster 的 existing；evidenceMemoryIds 必须属于本 cluster。
 * 无效 target 的 reinforce/refine/contradict/merge 退化为 create（防串写）。
 */
function normalizeDecision(raw: ObservationDecision, cluster: MemoryUnit[], related: Observation[]): ObservationDecision {
    const action = DECISION_ACTIONS.has(raw.action) ? raw.action : 'create';
    const clusterIds = new Set(cluster.map(f => f.id));
    const relatedIds = new Set(related.map(o => o.id));
    const evidence = Array.isArray(raw.evidenceMemoryIds)
        ? raw.evidenceMemoryIds.map(String).filter(id => clusterIds.has(id))
        : undefined;
    const text = typeof raw.text === 'string' ? raw.text.slice(0, 400) : undefined;
    const targetId = typeof raw.targetId === 'string' && relatedIds.has(raw.targetId) ? raw.targetId : undefined;
    const needsTarget = action === 'reinforce' || action === 'refine' || action === 'contradict' || action === 'merge';
    const finalAction = needsTarget && !targetId ? 'create' : action;
    return {
        action: finalAction,
        targetId: finalAction === 'create' ? undefined : targetId,
        text,
        ...(evidence && evidence.length ? { evidenceMemoryIds: evidence } : {}),
    } as ObservationDecision;
}

function countPending(units: MemoryUnit[]): number {
    return units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;
}

/**
 * P1-1 混合取数：最老的一半 + 重要度最高的一半（同分按入库序）。
 * 取完仍按 createdAtSeq 升序应用，保证同一主题的先后。
 * 目的：单 job 有界，同时避免低重要度事实被无限饿死。
 */
function pickPending(all: MemoryUnit[], limit: number): MemoryUnit[] {
    if (all.length <= limit) return all.slice();
    const oldestCount = Math.ceil(limit / 2);
    const oldest = all.slice(0, oldestCount);
    const chosen = new Set(oldest.map(f => f.id));
    const rest = all.filter(f => !chosen.has(f.id))
        .sort((a, b) => (b.importance - a.importance) || (a.createdAtSeq - b.createdAtSeq));
    return oldest.concat(rest.slice(0, limit - oldest.length))
        .sort((a, b) => a.createdAtSeq - b.createdAtSeq);
}

function clusterFacts(facts: MemoryUnit[]): MemoryUnit[][] {
    const clusters: MemoryUnit[][] = [];
    const used = new Set<string>();
    for (const fact of facts) {
        if (used.has(fact.id)) continue;
        const cluster = [fact];
        used.add(fact.id);
        for (const other of facts) {
            if (used.has(other.id)) continue;
            if (sameCluster(fact, other)) {
                cluster.push(other);
                used.add(other.id);
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

function unionTags(facts: MemoryUnit[]): string[] {
    const scope = new Set<string>();
    const visibility = new Set<string>();
    for (const f of facts) {
        for (const t of f.tags) {
            if (/^(user|group|global):/.test(t)) scope.add(t);
            else if (/^vis:/.test(t)) visibility.add(t);
        }
    }
    // 观察继承来源事实的可见性：owner 最严格优先，其次 origin；无 vis 视为 public
    if (visibility.has('vis:owner')) return [...Array.from(scope), 'vis:owner'];
    const origin = Array.from(visibility).find(t => t.startsWith('vis:origin:'));
    if (origin) return [...Array.from(scope), origin];
    return [...Array.from(scope), 'vis:public'];
}

function findRelatedObservations(observations: Observation[], cluster: MemoryUnit[]): Observation[] {
    const factIds = new Set(cluster.map(f => f.id));
    const clusterText = cluster.map(f => f.text).join(' ');
    const scope = new Set(cluster.reduce<string[]>((acc, f) => acc.concat(f.tags.filter(t => /^(user|group|global):/.test(t))), []));
    return observations
        .filter(o => o.status === 'active')
        .map(o => ({
            o,
            score: Math.max(
                o.evidence.some(e => factIds.has(e.memoryId)) ? 1 : 0,
                textSimilarity(o.text, clusterText),
                o.tags.some(t => scope.has(t)) ? 0.7 : 0,
            ),
        }))
        .filter(x => x.score >= 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.o);
}

function applyDecision(
    host: ConsolidationHost,
    bankId: string,
    cluster: MemoryUnit[],
    decision: ObservationDecision,
    out: { created: string[]; updated: string[]; merged: string[] },
): void {
    const repo = host.repository;
    const bank = repo.getBank(bankId);
    if (!bank) return;
    const now = Math.floor(Date.now() / 1000);
    const target = decision.targetId ? bank.observations.find(o => o.id === decision.targetId) : undefined;
    const evidenceIds = new Set(decision.evidenceMemoryIds || []);
    const chosen = evidenceIds.size ? cluster.filter(f => evidenceIds.has(f.id)) : cluster;
    const evidence = chosen.map(f => ({ memoryId: f.id, quote: f.text, addedAt: now }));
    const text = String(decision.text || '').trim() || chosen.map(f => f.text).join('；');
    const tags = unionTags(chosen);

    if (decision.action === 'noop') return;

    if (decision.action === 'create' || !target) {
        const observation: Observation = {
            id: generateId(),
            bankId,
            text,
            tags,
            evidence,
            proofCount: evidence.length,
            createdAt: now,
            updatedAt: now,
            lastSupportedAt: now,
            status: 'active',
            history: [{ text, reason: 'created', at: now }],
        };
        repo.addObservation(bankId, observation, false);
        out.created.push(observation.id);
        return;
    }

    if (decision.action === 'merge') {
        const other = target;
        const mergedEvidence = dedupeEvidence([...other.evidence, ...evidence]);
        other.evidence = mergedEvidence;
        other.proofCount = distinctLiveEvidence(bank, mergedEvidence);
        other.text = text;
        other.tags = mergeObservationTags(other.tags, tags);
        other.updatedAt = now;
        other.lastSupportedAt = now;
        other.history.push({ text, reason: 'merged', at: now });
        repo.updateObservation(bankId, other, false);
        out.merged.push(other.id);
        return;
    }

    const reason = decision.action === 'contradict' ? 'contradicted'
        : decision.action === 'reinforce' ? 'reinforced'
            : 'refined';
    const before = target.text;
    target.evidence = dedupeEvidence([...target.evidence, ...evidence]);
    target.proofCount = distinctLiveEvidence(bank, target.evidence);
    target.tags = mergeObservationTags(target.tags, tags);
    target.text = decision.action === 'reinforce' && !decision.text ? before : text;
    target.updatedAt = now;
    target.lastSupportedAt = now;
    target.history.push({ text, reason, at: now });
    repo.updateObservation(bankId, target, false);
    out.updated.push(target.id);
}

function dedupeEvidence<T extends { memoryId: string; quote: string }>(evidence: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const e of evidence) {
        const key = `${e.memoryId}:${e.quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out;
}

function mergeObservationTags(existing: string[], incoming: string[]): string[] {
    const scope = new Set<string>();
    let owner = false;
    let origin: string | undefined;
    for (const tag of [...existing, ...incoming]) {
        if (/^(user|group|global):/.test(tag)) scope.add(tag);
        else if (tag === 'vis:owner') owner = true;
        else if (tag.startsWith('vis:origin:')) origin = origin || tag;
    }
    scope.add(owner ? 'vis:owner' : origin || 'vis:public');
    return Array.from(scope);
}

export { sameCluster, textSimilarity };
