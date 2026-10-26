// Hindsight-like 记忆引擎：retain / recall / consolidation / mental model / reflect 的编排。
// 认知层细节在 consolidation.ts / mental_models.ts / reflection.ts / prompt.ts / structured.ts。
import { generateId } from "../../utils/id";
import { cosineSimilarity } from "../../utils/similarity";

import { canReadByTags, getOriginScope, getVisibility } from "./access";
import { doConsolidate } from "./consolidation";
import { MentalModelService } from "./mental_models";
import { reflect, scopeNoteForBank } from "./reflection";
import { MemoryRepository } from "./repository";
import {
    decayScore,
    DEDUP_THRESHOLD,
    estimateTokens,
    evictionGroup,
    filterByTags,
    keywordLimit,
    keywordScore,
    matchedStrategies,
    OBSERVATION_STALE_DAYS,
    rrf,
    SEMANTIC_LINK_MIN,
    SEMANTIC_SIMILARITY_THRESHOLD,
    semanticLimit,
    temporalSearch,
} from "./scoring";
import { type BankPart, InMemoryMemoryStorage, type MemoryStorage } from "./storage";
import type {
    ConsolidateOutcome,
    DeltaOperator,
    FactType,
    MemoryBankMeta,
    MemoryLink,
    MemoryUnit,
    MentalModel,
    MentalModelRefreshReason,
    MentalModelRefreshSummary,
    MentalModelTemplateId,
    MentalModelTrigger,
    Observation,
    ObservationDecisionMaker,
    RecallHit,
    RecallOptions,
    ReflectResult,
    ReflectSynthesizer,
    Reranker,
    RetainInput,
    RetainResult,
} from "./types";

export interface MemoryEngineOptions {
    storage?: MemoryStorage;
    embedding?: (text: string) => Promise<number[]>;
    rerank?: Reranker;
    observationDecision?: ObservationDecisionMaker;
    observationSynthesizer?: (quotes: string[]) => Promise<string>;
    reflectSynthesizer?: ReflectSynthesizer;
    deltaOps?: DeltaOperator;
    recencyWeight?: number;
    recencyHalfLifeDays?: number;
    memoryCap?: number;
    now?: () => number;
}

const DEFAULT_MAX_TOKENS = 2048;

export class MemoryEngine {
    readonly repository: MemoryRepository;
    private embedding?: (text: string) => Promise<number[]>;
    private rerank?: Reranker;
    private observationDecision?: ObservationDecisionMaker;
    private observationSynthesizer?: (quotes: string[]) => Promise<string>;
    private reflectSynthesizer?: ReflectSynthesizer;
    private deltaOps?: DeltaOperator;
    private readonly mentalModels: MentalModelService;
    private recencyWeight: number;
    private recencyHalfLifeDays: number;
    private memoryCap: number;
    private semanticThreshold = SEMANTIC_SIMILARITY_THRESHOLD;
    private nowFn: () => number;
    private consolidating = new Set<string>();

    constructor(options: MemoryEngineOptions = {}) {
        this.repository = new MemoryRepository(options.storage || new InMemoryMemoryStorage());
        this.embedding = options.embedding;
        this.rerank = options.rerank;
        this.observationDecision = options.observationDecision;
        this.observationSynthesizer = options.observationSynthesizer;
        this.reflectSynthesizer = options.reflectSynthesizer;
        this.deltaOps = options.deltaOps;
        this.recencyWeight = options.recencyWeight ?? 0.4;
        this.recencyHalfLifeDays = options.recencyHalfLifeDays ?? 60;
        this.memoryCap = options.memoryCap ?? 0;
        this.nowFn = options.now || (() => Math.floor(Date.now() / 1000));
        this.mentalModels = new MentalModelService({
            repository: this.repository,
            nowSec: () => this.nowSec(),
            reflect: (bankId, question, opts) => this.reflect(bankId, question, opts),
            deltaOps: this.deltaOps,
            embed: (text) => this.embedText(text),
        });
    }

    nowSec(): number { return this.nowFn(); }

    setReranker(rerank?: Reranker): void { this.rerank = rerank; }
    setObservationDecision(decider?: ObservationDecisionMaker): void { this.observationDecision = decider; }
    setObservationSynthesizer(synth?: (quotes: string[]) => Promise<string>): void { this.observationSynthesizer = synth; }
    setReflectSynthesizer(synth?: ReflectSynthesizer): void { this.reflectSynthesizer = synth; }
    setDeltaOps(ops?: DeltaOperator): void { this.deltaOps = ops; }
    setRecency(weight: number, halfLifeDays: number): void {
        this.recencyWeight = weight;
        this.recencyHalfLifeDays = halfLifeDays > 0 ? halfLifeDays : 60;
    }
    setMemoryCap(cap: number): void { this.memoryCap = cap > 0 ? cap : 0; }
    setSemanticThreshold(threshold: number): void {
        this.semanticThreshold = threshold > 0 ? threshold : SEMANTIC_SIMILARITY_THRESHOLD;
    }
    setMentalModelDefaults(opts: { mode?: MentalModelTrigger; excludeMentalModels?: boolean }): void {
        this.mentalModels.setDefaults(opts);
    }
    setRefreshMinInterval(seconds: number): void { this.mentalModels.setRefreshMinInterval(seconds); }
    setMentalModelLimits(opts: { maxTokens?: number; failedCooldownSec?: number; deltaFullRebuildSec?: number }): void {
        if (opts.maxTokens) this.mentalModels.setMaxTokens(opts.maxTokens);
        if (opts.failedCooldownSec) this.mentalModels.setFailedCooldown(opts.failedCooldownSec);
        if (opts.deltaFullRebuildSec) this.mentalModels.setDeltaFullRebuild(opts.deltaFullRebuildSec);
    }
    getLastAutoRefreshAt(bankId: string): number { return this.mentalModels.getLastAutoRefreshAt(bankId); }

    ensureBank(bankId: string, kind: MemoryBankMeta['kind'] = 'global', agentName = '', sessionId?: string): void {
        this.repository.getOrCreateBank(bankId, kind, agentName, sessionId);
    }

    private async embedText(text: string): Promise<number[]> {
        if (!this.embedding || !text) return [];
        try {
            const vec = await this.embedding(text);
            return Array.isArray(vec) ? vec : [];
        } catch {
            return [];
        }
    }

    // ===== retain =====

    async retain(bankId: string, input: RetainInput): Promise<RetainResult> {
        const content = String(input.content || '').trim();
        if (!content) return { unitIds: [], action: 'noop' };
        const bank = this.repository.getOrCreateBank(bankId);
        const hash = contentHash(content);
        const existing = this.repository.findUnitByHash(bankId, hash);
        if (existing) return { unitIds: [existing.id], action: 'duplicate' };

        const now = this.nowSec();
        const seq = (bank.meta.settings.nextFactSeq || 0) + 1;
        bank.meta.settings.nextFactSeq = seq;
        const id = generateId();
        const entityIds: string[] = [];
        const entityNames = Array.from(new Set((input.entities || []).map(e => String(e).trim()).filter(Boolean)));
        for (const name of entityNames) {
            const entity = this.repository.upsertEntity(bankId, name);
            entityIds.push(entity.id);
        }
        const unit: MemoryUnit = {
            id,
            bankId,
            text: content,
            factType: input.factType === 'experience' ? 'experience' : 'world',
            occurredStart: input.occurredStart,
            occurredEnd: input.occurredEnd,
            mentionedAt: input.timestamp ?? now,
            createdAt: now,
            createdAtSeq: seq,
            updatedAt: now,
            embedding: await this.embedText(content),
            entityIds,
            tags: Array.from(new Set(input.tags || [])),
            metadata: { ...(input.metadata || {}), contentHash: hash },
            supersedes: input.supersedes,
            importance: typeof input.importance === 'number' ? Math.max(0, Math.min(1, input.importance)) : 0.5,
            accessCount: 0,
            lastAccessedAt: 0,
            state: 'valid',
            consolidationState: 'pending',
        };
        this.repository.addUnit(bankId, unit, false);

        // 实体链接 + 语义链接（只对最近 200 条候选，避免 O(n²) 全库）
        const recent = this.repository.listUnits(bankId)
            .filter(u => u.id !== id && u.state === 'valid')
            .slice(-200);
        for (const candidate of recent) {
            if (entityIds.some(eid => candidate.entityIds.includes(eid))) {
                this.repository.addLink(bankId, this.link(id, candidate.id, 'entity', now));
            }
            if (unit.embedding.length && candidate.embedding.length) {
                try {
                    const sim = cosineSimilarity(unit.embedding, candidate.embedding);
                    if (sim >= SEMANTIC_LINK_MIN) this.repository.addLink(bankId, this.link(id, candidate.id, 'semantic', now, sim));
                } catch { /* ignore */ }
            }
        }
        this.repository.save(bankId, ['units', 'links', 'obs', 'meta'] as BankPart[]);
        if (this.memoryCap > 0) this.prune(bankId);
        return { unitIds: [id], action: 'added' };
    }

    private link(from: string, to: string, type: MemoryLink['linkType'], now: number, weight = 1): MemoryLink {
        return { fromUnitId: from, toUnitId: to, linkType: type, weight, createdAt: now };
    }

    // ===== recall =====

    async recall(bankId: string, options: RecallOptions): Promise<RecallHit[]> {
        const bank = this.repository.getBank(bankId);
        if (!bank) return [];
        const query = String(options.query || '');
        const tags = options.tags || [];
        const tagsMatch = options.tagsMatch ?? 'any';
        const types = options.types;
        let units = bank.units.filter(u =>
            (options.includeInvalidated || u.state === 'valid')
            && (!types || types.includes(u.factType))
            && (!options.createdAfterSeq || u.createdAtSeq > options.createdAfterSeq));
        units = filterByTags(units, tags, tagsMatch);
        if (units.length === 0) return [];

        const byId = new Map(units.map(u => [u.id, u]));
        const lists: Array<{ strategy: string; ids: string[] }> = [];

        // 语义
        if (this.embedding && query) {
            const qvec = await this.embedText(query);
            if (qvec.length) {
                const scored = units
                    .filter(u => u.embedding.length)
                    .map(u => ({ id: u.id, sim: safeCosine(qvec, u.embedding) }))
                    .filter(x => x.sim >= this.semanticThreshold)
                    .sort((a, b) => b.sim - a.sim)
                    .slice(0, semanticLimit(options.budget || 'mid'));
                lists.push({ strategy: 'semantic', ids: scored.map(x => x.id) });
            }
        }

        // 关键词
        if (query) {
            const kw = units
                .map(u => ({ id: u.id, score: keywordScore(u.text, query) }))
                .filter(x => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, keywordLimit(options.budget || 'mid'));
            if (kw.length) lists.push({ strategy: 'keyword', ids: kw.map(x => x.id) });
        }

        // 图（只从已过滤 units 出发，≤2 跳）
        if (query) {
            const seeds = units.filter(u => queryTokens(query).some(t => u.text.includes(t)) || u.tags.some(t => t.includes(query))).slice(0, 20);
            const graph = this.graphExpand(bank.links, seeds.map(u => u.id), byId, 2);
            if (graph.length) lists.push({ strategy: 'graph', ids: graph });
        }

        // 时间
        const temporal = temporalSearch(units, query);
        if (temporal.length) lists.push({ strategy: 'temporal', ids: temporal });

        let ordered = rrf(lists);
        if (ordered.length === 0) {
            // 无策略命中：空 query 按 importance+recency；有 query 返回空（不做插入序 backfill）
            if (!query) {
                ordered = units
                    .slice()
                    .sort((a, b) => (b.importance + recencyBonus(b, this.nowSec(), this.recencyWeight, this.recencyHalfLifeDays))
                        - (a.importance + recencyBonus(a, this.nowSec(), this.recencyWeight, this.recencyHalfLifeDays)))
                    .map(u => [u.id, u.importance] as [string, number]);
            }
        }

        // 可选 rerank（失败回退 RRF）
        const candidateIds = ordered.map(([id]) => id);
        let reranked = candidateIds;
        if (this.rerank && query && candidateIds.length > 1) {
            try {
                const candidates = candidateIds.map(id => byId.get(id)!).filter(Boolean).slice(0, 20);
                const ids = await this.rerank(query, candidates);
                if (Array.isArray(ids) && ids.length) {
                    reranked = ids.filter(id => byId.has(id));
                    for (const id of candidateIds) if (!reranked.includes(id)) reranked.push(id);
                }
            } catch {
                reranked = candidateIds;
            }
        }

        // 新近度加分（只作用于 RRF 结果）
        const scoreMap = new Map(ordered);
        const now = this.nowSec();
        reranked.sort((a, b) => {
            const ua = byId.get(a)!;
            const ub = byId.get(b)!;
            const sa = (scoreMap.get(a) || 0) + recencyBonus(ua, now, this.recencyWeight, this.recencyHalfLifeDays);
            const sb = (scoreMap.get(b) || 0) + recencyBonus(ub, now, this.recencyWeight, this.recencyHalfLifeDays);
            return sb - sa;
        });

        const hits: RecallHit[] = [];
        const usedTokens = new Map<string, number>();
        const addedObservations = new Set<string>();
        const activeObs = bank.observations.filter(o => o.status === 'active');
        const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
        const coveredFactIds = new Set<string>();
        if (options.collapseObservations) {
            for (const obs of activeObs) for (const e of obs.evidence) coveredFactIds.add(e.memoryId);
        }
        for (const id of reranked) {
            const unit = byId.get(id);
            if (!unit) continue;
            const cost = estimateTokens(unit.text);
            const used = sumTokens(usedTokens);
            if (maxTokens > 0 && used + cost > maxTokens) continue;
            if (options.collapseObservations && coveredFactIds.has(unit.id)) {
                const obs = activeObs.find(o => o.evidence.some(e => e.memoryId === unit.id));
                if (obs) {
                    if (addedObservations.has(obs.id)) continue;
                    addedObservations.add(obs.id);
                    const obsCost = estimateTokens(obs.text);
                    if (maxTokens > 0 && used + obsCost > maxTokens) continue;
                    hits.push({
                        kind: 'observation',
                        observation: obs,
                        score: scoreMap.get(id) || 0,
                        matchedStrategies: matchedStrategies(lists, id),
                    });
                    usedTokens.set(obs.id, obsCost);
                    continue;
                }
            }
            hits.push({
                kind: 'fact',
                unit,
                score: scoreMap.get(id) || 0,
                matchedStrategies: matchedStrategies(lists, id),
            });
            usedTokens.set(unit.id, cost);
        }

        // 访问计数：只对实际返回的 fact 更新一次；不落盘（调用方统一 save）
        for (const hit of hits) {
            if (hit.kind !== 'fact' || !hit.unit) continue;
            hit.unit.accessCount = (hit.unit.accessCount || 0) + 1;
            hit.unit.lastAccessedAt = now;
        }
        if (hits.some(h => h.kind === 'fact')) this.repository.save(bankId, ['units']);
        return hits;
    }

    private graphExpand(links: MemoryLink[], seeds: string[], byId: Map<string, MemoryUnit>, maxHops: number): string[] {
        const visited = new Set(seeds);
        let frontier = seeds;
        for (let hop = 0; hop < maxHops; hop++) {
            const next: string[] = [];
            for (const id of frontier) {
                for (const link of links) {
                    const other = link.fromUnitId === id ? link.toUnitId : link.toUnitId === id ? link.fromUnitId : '';
                    if (other && !visited.has(other) && byId.has(other)) {
                        visited.add(other);
                        next.push(other);
                    }
                }
            }
            frontier = next;
            if (!frontier.length) break;
        }
        return Array.from(visited).filter(id => !seeds.includes(id));
    }

    // ===== consolidation / mental models / reflect =====

    isConsolidating(bankId: string): boolean { return this.consolidating.has(bankId); }

    async consolidate(bankId: string, opts: { maxFacts?: number; targetedTags?: string[] } = {}): Promise<ConsolidateOutcome> {
        if (this.consolidating.has(bankId)) {
            return { created: [], updated: [], merged: [], skipped: 0, touchedTags: [], pendingRemaining: this.pendingCount(bankId) };
        }
        this.consolidating.add(bankId);
        try {
            return await doConsolidate({
                repository: this.repository,
                decideObservation: this.observationDecision,
                synthesizeObservation: this.observationSynthesizer,
            }, bankId, opts);
        } finally {
            this.consolidating.delete(bankId);
        }
    }

    async createMentalModel(bankId: string, sourceQuery: string, answer: string, tags: string[] = [], opts: {
        mode?: MentalModelTrigger;
        autoRefresh?: boolean;
        factTypes?: FactType[];
        templateId?: MentalModelTemplateId;
    } = {}): Promise<MentalModel> {
        return this.mentalModels.createMentalModel(bankId, sourceQuery, answer, tags, opts);
    }

    listMentalModels(bankId: string): MentalModel[] { return this.mentalModels.listMentalModels(bankId); }

    async deleteMentalModel(bankId: string, id: string): Promise<void> { return this.mentalModels.deleteMentalModel(bankId, id); }

    async ensureDefaultMentalModels(bankId: string, kind: 'user' | 'group' | 'global', scopeTag: string, enabled = true): Promise<string[]> {
        return this.mentalModels.ensureDefaultMentalModels(bankId, kind, scopeTag, enabled);
    }

    async refreshMentalModels(bankId: string, id: string | undefined, opts: {
        force?: boolean;
        reason?: MentalModelRefreshReason;
        touchedTags?: string[];
        ids?: string[];
    } = {}): Promise<MentalModelRefreshSummary & { seedIds?: string[] }> {
        return this.mentalModels.refreshMentalModels(bankId, id, opts);
    }

    async refreshMentalModel(bankId: string, id: string, opts: { force?: boolean; reason?: MentalModelRefreshReason } = {}): Promise<MentalModelRefreshSummary> {
        return this.mentalModels.refreshMentalModels(bankId, id, opts);
    }

    async reflect(bankId: string, query: string, opts: {
        factTypes?: FactType[];
        scopeTags?: string[];
        excludeMentalModelIds?: string[];
        createdAfterSeq?: number;
        mode?: MentalModelTrigger;
        existingAnswer?: string;
        strict?: boolean;
        maxTokens?: number;
        scopeNote?: string;
        fastPath?: boolean;
    } = {}): Promise<ReflectResult> {
        return reflect({
            repository: this.repository,
            reflectSynthesizer: this.reflectSynthesizer,
            recall: (b, q, o) => this.recall(b, { query: q, ...o } as RecallOptions),
            searchModels: (b, q, tags) => this.mentalModels.searchMentalModels(b, q, tags),
        }, bankId, query, opts);
    }

    searchMentalModels(bankId: string, query: string, tags: string[] = []): Array<{ model: MentalModel; score: number; stale: boolean }> {
        return this.mentalModels.searchMentalModels(bankId, query, tags);
    }

    pendingCount(bankId: string): number {
        const bank = this.repository.getBank(bankId);
        if (!bank) return 0;
        return bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;
    }

    async computeMentalModelEmbedding(model: MentalModel): Promise<void> {
        const vec = await this.embedText(`${model.sourceQuery}\n${model.content}`);
        if (vec.length) model.embedding = vec;
    }

    // ===== retention =====

    prune(bankId: string): string[] {
        if (this.memoryCap <= 0) return [];
        const bank = this.repository.getBank(bankId);
        if (!bank) return [];
        const valid = bank.units.filter(u => u.state === 'valid');
        if (valid.length <= this.memoryCap) return [];
        const now = this.nowSec();
        const covered = new Set<string>();
        for (const obs of bank.observations) if (obs.status === 'active') for (const e of obs.evidence) covered.add(e.memoryId);
        const protectedByEvidence = covered;
        const candidates = valid
            .filter(u => !protectedByEvidence.has(u.id))
            .sort((a, b) => {
                const ga = evictionGroup(a, covered);
                const gb = evictionGroup(b, covered);
                if (ga !== gb) return ga - gb;
                return decayScore(a, now) - decayScore(b, now);
            });
        const need = valid.length - this.memoryCap;
        const evict = candidates.slice(0, need).map(u => u.id);
        if (evict.length) this.repository.deleteUnits(bankId, evict, true);
        return evict;
    }

    /** 观察过期派生：不删除，只用于注入/status。 */
    observationExpired(obs: Observation, now = this.nowSec()): boolean {
        return now - (obs.lastSupportedAt || obs.updatedAt || obs.createdAt) > OBSERVATION_STALE_DAYS * 86400;
    }

    canReadUnit(unit: MemoryUnit, viewer: Parameters<typeof canReadByTags>[2]): boolean {
        return canReadByTags(unit.bankId, unit.tags, viewer);
    }
}

function sumTokens(map: Map<string, number>): number {
    let sum = 0;
    for (const v of map.values()) sum += v;
    return sum;
}

function safeCosine(a: number[], b: number[]): number {
    try { return cosineSimilarity(a, b); } catch { return 0; }
}

function recencyBonus(unit: MemoryUnit, now: number, weight: number, halfLifeDays: number): number {
    if (!weight || weight <= 0) return 0;
    const last = unit.lastAccessedAt || unit.updatedAt || unit.createdAt || now;
    const ageDays = Math.max(0, (now - last) / 86400);
    return weight * Math.exp((-Math.LN2 * ageDays) / Math.max(1, halfLifeDays)) * 0.01;
}

function contentHash(text: string): string {
    let h = 2166136261;
    const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

function queryTokens(query: string): string[] {
    return String(query || '').split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(t => t.length >= 1);
}

export { scopeNoteForBank, getVisibility, getOriginScope, DEDUP_THRESHOLD };

