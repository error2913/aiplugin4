// 记忆巩固/观察同步/淘汰（叶子）：LLM 合成观察记忆 → 观察单元同步 → 相似观察合并 → 过期清理 → 超限淘汰。
// 从 memory/v2/engine.ts 拆出——只依赖 repository + 合成回调 + 打分函数，便于单测；
// engine.ts 保留 consolidate() 入口（含防重入锁）与 pruneBank 包装。
import { generateId } from "../../utils/id";

import { OBSERVATION_STALE_DAYS } from "./prompt";
import type { MemoryRepository } from "./repository";
import { decayScore, evictionGroup, sameCluster, SEMANTIC_SIMILARITY_THRESHOLD } from "./scoring";
import type {
    ConsolidationResult,
    MemoryUnit,
    Observation,
    ObservationSynthesizer,
} from "./types";

/** 巩固所需的最小宿主视图（MemoryEngine 满足）：repository + 可选的观察合成回调 */
export interface ObservationStore {
    repository: MemoryRepository;
    synthesizeObservation?: ObservationSynthesizer;
}

export async function doConsolidate(store: ObservationStore, bankId: string): Promise<ConsolidationResult> {
    const bank = store.repository.getBank(bankId);
    if (!bank) return { created: [], updated: [], merged: [], skipped: 0 };

    // Hindsight 式惰性清理：观察记忆长期未验证视为过期，直接清理（连同同步 unit/evidence/links）
    const staleRemoved = cleanupStaleObservations(store.repository, bankId);

    const pending = bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending');
    if (pending.length === 0) {
        // 清理过期观察可能已产生变更，仍需落盘一次
        if (staleRemoved > 0) store.repository.save(bankId);
        return { created: [], updated: [], merged: [], skipped: 0 };
    }

    const clusters: MemoryUnit[][] = [];
    const used = new Set<string>();
    for (const unit of pending) {
        if (used.has(unit.id)) continue;
        const cluster = [unit];
        used.add(unit.id);
        for (const other of pending) {
            if (used.has(other.id)) continue;
            if (sameCluster(unit, other)) {
                cluster.push(other);
                used.add(other.id);
            }
        }
        clusters.push(cluster);
    }

    const created: string[] = [];
    const updated: string[] = [];
    const merged: string[] = [];
    const skipped = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const cluster of clusters) {
        const quotes = cluster.map(u => u.text);
        const evidence = cluster.map(u => ({ memoryId: u.id, quote: u.text }));
        const observationText = await synthesizeObservationText(store, quotes);
        const similar = bank.observations.find(o => o.evidence.some(e => cluster.some(u => u.id === e.memoryId)));
        if (similar) {
            similar.evidence = Array.from(new Map([...similar.evidence, ...evidence].map(e => [`${e.memoryId}:${e.quote}`, e])).values());
            similar.proofCount = similar.evidence.length;
            similar.text = observationText;
            similar.history.push({ text: observationText, reason: 'refined', at: now });
            similar.updatedAt = now;
            similar.lastVerifiedAt = now;
            store.repository.updateObservation(bankId, similar, false);
            syncObservationUnit(store.repository, bankId, similar, now, false);
            updated.push(similar.id);
        } else {
            const obsId = generateId();
            const observation: Observation = {
                id: obsId,
                bankId,
                text: observationText,
                scopeTags: cluster.reduce<string[]>((acc, u) => acc.concat(u.tags), []).filter(t => t.startsWith('user:') || t.startsWith('group:')),
                evidence,
                proofCount: evidence.length,
                createdAt: now,
                updatedAt: now,
                lastVerifiedAt: now,
                history: [{ text: observationText, reason: 'created', at: now }],
            };
            store.repository.addObservation(bankId, observation, false);
            syncObservationUnit(store.repository, bankId, observation, now, false);
            created.push(obsId);
        }
        store.repository.markUnitConsolidated(bankId, cluster.map(u => u.id), undefined, false);
    }

    const dedup = store.repository.mergeSimilarObservations(bankId, SEMANTIC_SIMILARITY_THRESHOLD, false);
    merged.push(...dedup.merged);

    // 批量写穿：consolidate 全程 persist=false 累计变更，末尾统一落盘一次
    store.repository.save(bankId);
    return { created, updated, merged, skipped };
}

/** 清理超过 OBSERVATION_STALE_DAYS 未验证的观察记忆（与注入时的 STALE 剔除口径一致） */
export function cleanupStaleObservations(repository: MemoryRepository, bankId: string): number {
    const bank = repository.getBank(bankId);
    if (!bank) return 0;
    const now = Math.floor(Date.now() / 1000);
    const staleCutoff = now - OBSERVATION_STALE_DAYS * 86400;
    const staleIds = bank.observations
        .filter(o => (o.lastVerifiedAt ?? o.updatedAt ?? 0) < staleCutoff)
        .map(o => o.id);
    for (const obsId of staleIds) {
        repository.deleteObservation(bankId, obsId, false);
    }
    return staleIds.length;
}

export async function synthesizeObservationText(store: ObservationStore, quotes: string[]): Promise<string> {
    if (store.synthesizeObservation && quotes.length > 0) {
        try {
            const text = await store.synthesizeObservation(quotes);
            if (text && text.trim()) return text.trim();
        } catch {
            // 合成失败时退回简单拼接
        }
    }
    return quotes.join('；');
}

export function syncObservationUnit(repository: MemoryRepository, bankId: string, observation: Observation, now: number, persist = true): void {
    let unit = repository.getUnit(bankId, observation.id);
    if (!unit) {
        unit = {
            id: observation.id,
            bankId,
            text: observation.text,
            factType: 'observation',
            createdAt: observation.createdAt,
            updatedAt: observation.updatedAt,
            embedding: [],
            entityIds: [],
            tags: observation.scopeTags,
            metadata: {},
            importance: 0.8,
            accessCount: 0,
            lastAccessedAt: now,
            state: 'valid',
            consolidationState: 'done',
        };
        repository.addUnit(bankId, unit, persist);
    } else {
        unit.text = observation.text;
        unit.tags = observation.scopeTags;
        unit.updatedAt = observation.updatedAt;
        repository.updateUnit(bankId, unit, persist);
    }
}

/** 召回/巩固后触发：超过条数上限时物理删除多余记忆（上限为硬约束）。返回被淘汰的 unit id */
export async function pruneBank(repository: MemoryRepository, memoryCap: number, bankId: string, persist = true): Promise<string[]> {
    if (memoryCap <= 0) return [];
    const bank = repository.getBank(bankId);
    if (!bank) return [];
    const valid = bank.units.filter(u => u.state === 'valid');
    if (valid.length <= memoryCap) return [];

    const now = Math.floor(Date.now() / 1000);
    const coveredIds = new Set<string>();
    for (const o of bank.observations) {
        for (const e of o.evidence) coveredIds.add(e.memoryId);
    }
    const sorted = valid.slice().sort((a, b) => {
        const ga = evictionGroup(a, coveredIds);
        const gb = evictionGroup(b, coveredIds);
        if (ga !== gb) return ga - gb;
        const da = decayScore(a, now);
        const db = decayScore(b, now);
        if (da !== db) return da - db;
        return (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0);
    });
    const toEvict = sorted.slice(0, valid.length - memoryCap).map(u => u.id);
    if (toEvict.length > 0) repository.deleteUnits(bankId, toEvict, persist);
    return toEvict;
}
