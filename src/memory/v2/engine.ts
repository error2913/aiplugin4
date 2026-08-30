// Hindsight-like 记忆引擎：Retain / Recall / Consolidation / Reflect 的纯 TS 实现。
// 设计参考 Hindsight：MemoryUnit + Entity + MemoryLink + Observation + MentalModel。
import { buildCharNGrams } from "../../utils/string";
import { cosineSimilarity, generateId } from "../../utils/utils";

import { OBSERVATION_STALE_DAYS } from "./prompt";
import { MemoryRepository, normalizeName } from "./repository";
import { InMemoryMemoryStorage, MemoryStorage } from "./storage";
import type {
    ConsolidationResult,
    FactExtractor,
    MemoryBankMeta,
    MemoryUnit,
    MentalModel,
    Observation,
    ObservationSynthesizer,
    RecallOptions,
    RecallResult,
    ReflectResult,
    ReflectSynthesizer,
    Reranker,
    RetainInput,
    RetainResult,
} from "./types";

const RRF_K = 60;
const DEFAULT_MAX_TOKENS = 2048;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.8;
const BACKFILL_BATCH_LIMIT = 20;
const NO_MEMORY_TEXT = '暂无足够记忆进行推理';

/** 「设定」心智模型的固定问题：.ai memo p|g st 与 persona 迁移共用，同问题名即同一条 */
export const MENTAL_MODEL_PERSONA_QUESTION = '这个用户/群的设定是什么？';

export interface MemoryEngineOptions {
    storage?: MemoryStorage;
    embedding?: (text: string) => Promise<number[]>;
    extract?: FactExtractor;
    rerank?: Reranker;
    synthesizeObservation?: ObservationSynthesizer;
    reflectSynthesizer?: ReflectSynthesizer;
    /** 检索新近度加分权重（0 为关闭，默认 0.4） */
    recencyWeight?: number;
    /** 新近度加分半衰期（天），默认 60 */
    recencyHalfLifeDays?: number;
}

export class MemoryEngine {
    readonly repository: MemoryRepository;
    private embedding?: (text: string) => Promise<number[]>;
    private extract?: FactExtractor;
    private rerank?: Reranker;
    private synthesizeObservation?: ObservationSynthesizer;
    private reflectSynthesizer?: ReflectSynthesizer;
    /** 正在刷新心智模型的 bank（防重入） */
    private refreshingBanks = new Set<string>();
    /** 正在巩固的 bank（防重入） */
    private consolidatingBanks = new Set<string>();
    /** 自动刷新最小间隔（秒），0 为不限制 */
    private refreshMinIntervalSec = 0;
    /** 各 bank 最近一次自动刷新时间（秒） */
    private lastRefreshAt = new Map<string, number>();
    /** 检索新近度加分权重（0 为关闭，默认 0.4） */
    private recencyWeight = 0.4;
    /** 新近度加分半衰期（天），默认 60 */
    private recencyHalfLifeDays = 60;

    constructor(options: MemoryEngineOptions = {}) {
        this.repository = new MemoryRepository(options.storage || new InMemoryMemoryStorage());
        this.embedding = options.embedding;
        this.extract = options.extract;
        this.rerank = options.rerank;
        this.synthesizeObservation = options.synthesizeObservation;
        this.reflectSynthesizer = options.reflectSynthesizer;
        this.recencyWeight = options.recencyWeight ?? 0.4;
        this.recencyHalfLifeDays = options.recencyHalfLifeDays ?? 60;
    }

    setExtractor(extract: FactExtractor): void {
        this.extract = extract;
    }

    setReranker(rerank: Reranker): void {
        this.rerank = rerank;
    }

    setObservationSynthesizer(synthesizeObservation: ObservationSynthesizer): void {
        this.synthesizeObservation = synthesizeObservation;
    }

    setReflectSynthesizer(reflectSynthesizer: ReflectSynthesizer): void {
        this.reflectSynthesizer = reflectSynthesizer;
    }

    /** 自动刷新最小间隔（秒）：consolidate 后的自动刷新受此限流，0 为不限制 */
    setRefreshMinInterval(seconds: number): void {
        this.refreshMinIntervalSec = seconds > 0 ? seconds : 0;
    }

    /** 配置检索新近度加权：weight<=0 关闭；halfLifeDays 为加分半衰期（天） */
    setRecency(weight: number, halfLifeDays: number): void {
        this.recencyWeight = weight > 0 ? weight : 0;
        this.recencyHalfLifeDays = halfLifeDays > 0 ? halfLifeDays : 60;
    }

    // ===== Bank =====

    ensureBank(bankId: string, kind: MemoryBankMeta['kind'] = 'global', agentName = ''): void {
        this.repository.getOrCreateBank(bankId, kind, agentName);
    }

    deleteBank(bankId: string): void {
        this.repository.deleteBank(bankId);
    }

    // ===== Retain =====

    async retain(bankId: string, input: RetainInput): Promise<RetainResult> {
        const text = String(input.content || '').trim();
        if (!text) return { unitIds: [], action: 'noop' };
        const now = Math.floor(Date.now() / 1000);
        const bank = this.repository.getOrCreateBank(bankId, 'global');
        const timestamp = input.timestamp || now;

        if (input.verbatim === false && this.extract) {
            const facts = await this.extract(input);
            if (facts.length === 0) return { unitIds: [], action: 'noop' };
            const unitIds: string[] = [];
            let lastAction: RetainResult['action'] = 'added';
            for (const fact of facts) {
                const r = await this.retain(bankId, {
                    ...input,
                    content: fact.text,
                    context: fact.context || input.context,
                    entities: fact.entities || input.entities,
                    factType: fact.factType || input.factType,
                    occurredStart: fact.occurredStart,
                    occurredEnd: fact.occurredEnd,
                    importance: fact.importance ?? input.importance,
                    verbatim: true,
                });
                if (r.unitIds[0]) unitIds.push(r.unitIds[0]);
                if (r.action !== 'added') lastAction = r.action;
            }
            return { unitIds, action: lastAction };
        }


        // 精确查重：同 bank 同文本合并。
        const normalized = normalizeName(text);
        const existing = bank.units.find(u => u.state === 'valid' && normalizeName(u.text) === normalized);
        if (existing) {
            existing.tags = Array.from(new Set([...existing.tags, ...(input.tags || [])]));
            existing.metadata = { ...existing.metadata, ...(input.metadata || {}) };
            existing.importance = Math.max(existing.importance, input.importance ?? existing.importance);
            existing.accessCount++;
            existing.lastAccessedAt = now;
            existing.updatedAt = now;
            this.repository.updateUnit(bankId, existing);
            return { unitIds: [existing.id], action: 'merged' };
        }

        const unitId = generateId();
        const entityIds = this.resolveEntityIds(bankId, input.entities || []);
        const unit: MemoryUnit = {
            id: unitId,
            bankId,
            documentId: input.documentId,
            text,
            context: input.context,
            factType: input.factType || 'world',
            occurredStart: input.occurredStart,
            occurredEnd: input.occurredEnd,
            mentionedAt: timestamp,
            createdAt: now,
            updatedAt: now,
            embedding: await this.embedText(text),
            entityIds,
            tags: input.tags || [],
            metadata: input.metadata || {},
            importance: input.importance ?? 0.5,
            accessCount: 0,
            lastAccessedAt: now,
            state: 'valid',
            consolidationState: 'pending',
        };
        this.repository.addUnit(bankId, unit);

        // 实体链接：同一实体的所有有效记忆互连。
        for (const entityId of entityIds) {
            const linked = bank.units.filter(u => u.id !== unitId && u.state === 'valid' && u.entityIds.includes(entityId));
            for (const other of linked) {
                this.repository.addLink(bankId, {
                    fromUnitId: unitId,
                    toUnitId: other.id,
                    linkType: 'entity',
                    entityId,
                    weight: 1,
                    createdAt: now,
                });
            }
        }

        // 语义近似链接：向量可用时，与高相似记忆建立 semantic link。
        if (unit.embedding.length > 0) {
            for (const other of bank.units) {
                if (other.id === unitId || other.state !== 'valid' || other.embedding.length === 0) continue;
                const sim = cosineSimilarity(unit.embedding, other.embedding);
                if (sim >= SEMANTIC_SIMILARITY_THRESHOLD) {
                    this.repository.addLink(bankId, {
                        fromUnitId: unitId,
                        toUnitId: other.id,
                        linkType: 'semantic',
                        weight: sim,
                        createdAt: now,
                    });
                }
            }
        }

        if (input.documentId) {
            this.repository.addDocument(bankId, {
                id: input.documentId,
                bankId,
                originalText: text,
                contentHash: simpleHash(text),
                createdAt: now,
                metadata: input.metadata || {},
            });
            this.repository.addChunk(bankId, {
                id: `${input.documentId}_${unitId}`,
                documentId: input.documentId,
                bankId,
                text,
                embedding: unit.embedding.length ? unit.embedding : undefined,
            });
        }

        return { unitIds: [unitId], documentId: input.documentId, action: 'added' };
    }

    async addMemory(bankId: string, input: RetainInput): Promise<RetainResult> {
        return this.retain(bankId, { ...input, verbatim: true });
    }

    // ===== Recall =====

    async recall(bankId: string, query: string, options: Partial<RecallOptions> = {}): Promise<RecallResult[]> {
        const bank = this.repository.getBank(bankId);
        if (!bank) return [];
        const q = String(query || '').trim();
        const opts: RecallOptions = {
            query: q,
            tags: options.tags || [],
            tagsMatch: options.tagsMatch || 'any',
            types: options.types || ['world', 'experience', 'observation'],
            maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
            budget: options.budget || 'mid',
            includeChunks: !!options.includeChunks,
            preferObservations: !!options.preferObservations,
        };

        let units = bank.units.filter(u => u.state === 'valid' && (opts.types ?? ['world', 'experience', 'observation']).includes(u.factType));
        units = this.filterByTags(units, opts.tags || [], opts.tagsMatch || 'any');

        if (units.length === 0) return [];

        const queryEmbedding = q ? await this.embedText(q) : [];

        // 存量回填：语义检索可用时，对尚无向量的记忆惰性补算并落库（每轮限量，避免阻塞）
        if (queryEmbedding.length > 0) {
            await this.backfillEmbeddings(bankId, units);
        }
        const strategyResults: Array<{ strategy: string; ids: string[] }> = [];

        // 1. Semantic
        if (queryEmbedding.length > 0) {
            const ranked = units
                .filter(u => u.embedding.length > 0)
                .map(u => ({ id: u.id, sim: cosineSimilarity(queryEmbedding, u.embedding) }))
                .sort((a, b) => b.sim - a.sim)
                .slice(0, this.semanticLimit(opts.budget || 'mid'));
            strategyResults.push({ strategy: 'semantic', ids: ranked.map(r => r.id) });
        }

        // 2. Keyword / BM25-like
        const keywordRanked = units
            .map(u => ({ id: u.id, score: this.keywordScore(u.text, q) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, this.keywordLimit(opts.budget || 'mid'));
        strategyResults.push({ strategy: 'keyword', ids: keywordRanked.map(r => r.id) });

        // 3. Graph
        const graphIds = this.graphSearch(bankId, q, opts.budget || 'mid');
        if (graphIds.length > 0) strategyResults.push({ strategy: 'graph', ids: graphIds });

        // 4. Temporal
        const temporalIds = this.temporalSearch(units, q);
        if (temporalIds.length > 0) strategyResults.push({ strategy: 'temporal', ids: temporalIds });

        let rrfEntries = this.rrf(strategyResults);
        const results: RecallResult[] = [];
        const usedTokens = new Map<string, number>();
        const unitById = new Map(units.map(u => [u.id, u]));
        // 本轮是否有命中被 touch：有则末尾统一落盘一次（touchUnit 只改内存，避免每条命中整库序列化）
        let touched = false;

        if (this.rerank && q && rrfEntries.length > 0) {
            const candidates = rrfEntries
                .slice(0, 20)
                .map(([id]) => unitById.get(id))
                .filter((u): u is MemoryUnit => !!u);
            try {
                const rankedIds = await this.rerank(q, candidates);
                const rank = new Map(rankedIds.map((id, index) => [id, index]));
                rrfEntries = rrfEntries.slice().sort((a, b) => {
                    const ra = rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
                    const rb = rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
                    return ra - rb;
                });
            } catch {
                // rerank 失败时保留 RRF 原始排序
            }
        }

        // Hindsight 式新近度加分：按 lastAccessedAt 做指数衰减加权（半衰期 halfLife），
        // 让"最近用过/验证过"的记忆在同等相关度下更靠前；不删除旧记忆，只影响召回排序。
        if (this.recencyWeight > 0 && rrfEntries.length > 0) {
            const nowSec = Math.floor(Date.now() / 1000);
            rrfEntries = rrfEntries
                .map(([id, score]) => {
                    const u = unitById.get(id);
                    if (!u) return [id, score] as [string, number];
                    const last = u.lastAccessedAt || u.updatedAt || u.createdAt || nowSec;
                    const ageDays = Math.max(0, (nowSec - last) / 86400);
                    const bonus = this.recencyWeight * Math.exp((-Math.log(2) * ageDays) / this.recencyHalfLifeDays);
                    return [id, score + bonus] as [string, number];
                })
                .sort((a, b) => b[1] - a[1]);
        }

        for (const [id, rrfScoreValue] of rrfEntries) {
            const unit = unitById.get(id);
            if (!unit) continue;
            if (opts.preferObservations && unit.factType !== 'observation') {
                const obs = bank.observations.find(o => o.evidence.some(e => e.memoryId === id));
                if (obs) {
                    const obsUnit = units.find(u => u.id === obs.id);
                    if (obsUnit && !results.some(r => r.unit.id === obs.id)) {
                        const before = results.length;
                        this.pushResult(results, usedTokens, { unit: obsUnit, score: rrfScoreValue, matchedStrategies: this.matchedStrategies(strategyResults, id) }, opts.maxTokens || DEFAULT_MAX_TOKENS);
                        if (results.length > before) {
                            this.touchUnit(bankId, obsUnit);
                            touched = true;
                        }
                        continue;
                    }
                }
            }
            const item: RecallResult = {
                unit,
                score: rrfScoreValue,
                matchedStrategies: this.matchedStrategies(strategyResults, id),
            };
            if (opts.includeChunks && unit.documentId) {
                item.chunks = this.repository.listChunks(bankId, unit.documentId);
            }
            const before = results.length;
            this.pushResult(results, usedTokens, item, opts.maxTokens || DEFAULT_MAX_TOKENS);
            if (results.length > before) {
                this.touchUnit(bankId, unit);
                touched = true;
            }
        }

        // 如果 token 预算宽松，用关键词/重要性补足（Hindsight recall 同样有 backfill 行为）
        const known = new Set(results.map(r => r.unit.id));
        for (const u of units) {
            if (known.has(u.id)) continue;
            const item: RecallResult = {
                unit: u,
                score: u.importance,
                matchedStrategies: [],
            };
            const before = results.length;
            this.pushResult(results, usedTokens, item, opts.maxTokens || DEFAULT_MAX_TOKENS);
            if (results.length > before) {
                this.touchUnit(bankId, u);
                touched = true;
            }
        }

        // 统一落盘一次（原实现每条命中都整库 JSON.stringify + storageSet，记忆库越大越慢）
        if (touched) this.repository.save(bankId);

        return results;
    }

    // ===== Observations / Consolidation =====

    async consolidate(bankId: string): Promise<ConsolidationResult> {
        // 防重入：同一 bank 的巩固已在执行时直接跳过，避免并发重复合并
        if (this.consolidatingBanks.has(bankId)) return { created: [], updated: [], merged: [], skipped: 0 };
        this.consolidatingBanks.add(bankId);
        try {
            return await this.doConsolidate(bankId);
        } finally {
            this.consolidatingBanks.delete(bankId);
        }
    }

    private async doConsolidate(bankId: string): Promise<ConsolidationResult> {
        const bank = this.repository.getBank(bankId);
        if (!bank) return { created: [], updated: [], merged: [], skipped: 0 };

        // Hindsight 式惰性清理：观察记忆长期未验证视为过期，直接清理（连同同步 unit/evidence/links）
        this.cleanupStaleObservations(bankId);

        const pending = bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending');
        if (pending.length === 0) return { created: [], updated: [], merged: [], skipped: 0 };

        const clusters: MemoryUnit[][] = [];
        const used = new Set<string>();
        for (const unit of pending) {
            if (used.has(unit.id)) continue;
            const cluster = [unit];
            used.add(unit.id);
            for (const other of pending) {
                if (used.has(other.id)) continue;
                if (this.sameCluster(unit, other)) {
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
            const observationText = await this.synthesizeObservationText(quotes);
            const similar = bank.observations.find(o => o.evidence.some(e => cluster.some(u => u.id === e.memoryId)));
            if (similar) {
                similar.evidence = Array.from(new Map([...similar.evidence, ...evidence].map(e => [`${e.memoryId}:${e.quote}`, e])).values());
                similar.proofCount = similar.evidence.length;
                similar.text = observationText;
                similar.history.push({ text: observationText, reason: 'refined', at: now });
                similar.updatedAt = now;
                similar.lastVerifiedAt = now;
                this.repository.updateObservation(bankId, similar);
                this.syncObservationUnit(bankId, similar, now);
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
                this.repository.addObservation(bankId, observation);
                this.syncObservationUnit(bankId, observation, now);
                created.push(obsId);
            }
            this.repository.markUnitConsolidated(bankId, cluster.map(u => u.id));
        }

        const dedup = this.repository.mergeSimilarObservations(bankId, SEMANTIC_SIMILARITY_THRESHOLD);
        merged.push(...dedup.merged);

        return { created, updated, merged, skipped };
    }


    /** 清理超过 OBSERVATION_STALE_DAYS 未验证的观察记忆（与注入时的 STALE 剔除口径一致） */
    private cleanupStaleObservations(bankId: string): void {
        const bank = this.repository.getBank(bankId);
        if (!bank) return;
        const now = Math.floor(Date.now() / 1000);
        const staleCutoff = now - OBSERVATION_STALE_DAYS * 86400;
        const staleIds = bank.observations
            .filter(o => (o.lastVerifiedAt ?? o.updatedAt ?? 0) < staleCutoff)
            .map(o => o.id);
        for (const obsId of staleIds) {
            this.repository.deleteObservation(bankId, obsId);
        }
    }

    // ===== Consolidation 计数（驱动「每隔多少次观察整合一次记忆」配置） =====

    getConsolidateSince(bankId: string): number {
        const bank = this.repository.getBank(bankId);
        return bank?.meta.settings.consolidateSince ?? 0;
    }

    setConsolidateSince(bankId: string, count: number): void {
        const bank = this.repository.getOrCreateBank(bankId, 'global');
        bank.meta.settings.consolidateSince = count;
        this.repository.save(bankId);
    }

    private async synthesizeObservationText(quotes: string[]): Promise<string> {
        if (this.synthesizeObservation && quotes.length > 0) {
            try {
                const text = await this.synthesizeObservation(quotes);
                if (text && text.trim()) return text.trim();
            } catch {
                // 合成失败时退回简单拼接
            }
        }
        return quotes.join('；');
    }

    private syncObservationUnit(bankId: string, observation: Observation, now: number): void {
        let unit = this.repository.getUnit(bankId, observation.id);
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
            this.repository.addUnit(bankId, unit);
        } else {
            unit.text = observation.text;
            unit.tags = observation.scopeTags;
            unit.updatedAt = observation.updatedAt;
            this.repository.updateUnit(bankId, unit);
        }
    }

    // ===== Mental Models =====

    listMentalModels(bankId: string): MentalModel[] {
        return this.repository.listMentalModels(bankId);
    }

    async createMentalModel(bankId: string, question: string, answer: string, scopeTags: string[] = []): Promise<MentalModel> {
        const now = Math.floor(Date.now() / 1000);
        const existing = this.repository.listMentalModels(bankId).find(m => m.question === question);
        if (existing) {
            existing.answer = answer;
            existing.scopeTags = scopeTags;
            existing.updatedAt = now;
            existing.version++;
            if (typeof existing.lastRefreshedAt !== 'number') existing.lastRefreshedAt = now;
            if (!Array.isArray(existing.history)) existing.history = [];
            if (existing.trigger !== 'full' && existing.trigger !== 'delta') existing.trigger = 'full';
            this.repository.updateMentalModel(bankId, existing);
            return existing;
        }
        const model: MentalModel = {
            id: generateId(),
            bankId,
            question,
            answer,
            scopeTags,
            createdAt: now,
            updatedAt: now,
            version: 1,
            lastRefreshedAt: now,
            history: [],
            trigger: 'full',
        };
        this.repository.addMentalModel(bankId, model);
        return model;
    }

    deleteMentalModel(bankId: string, id: string): boolean {
        return this.repository.deleteMentalModel(bankId, id);
    }

    /**
     * 刷新心智模型：基于现有记忆重新推理每个问题；传 id 时只刷新该条。
     * - 空内容保护：合成失败 / 无足够记忆时不覆盖旧答案
     * - 未变化跳过：结果与旧答案相同不 bump version
     * 返回实际更新的条数。
     */
    async refreshMentalModels(bankId: string, id?: string, opts: { force?: boolean } = {}): Promise<number> {
        // 防重入：同一 bank 正在刷新时直接跳过，避免并发重复调用
        if (this.refreshingBanks.has(bankId)) return 0;
        // 最小间隔限流：自动刷新（非 force）受「心智模型刷新最小间隔」配置限制
        const nowSec0 = Math.floor(Date.now() / 1000);
        if (!opts.force && this.refreshMinIntervalSec > 0) {
            const last = this.lastRefreshAt.get(bankId) || 0;
            if (last > 0 && nowSec0 - last < this.refreshMinIntervalSec) return 0;
        }
        const models = this.repository.listMentalModels(bankId).filter(m => !id || m.id === id);
        // 空内容保护：无观察/事实可依据时跳过，避免把模型自身内容当“新推理结果”反复刷版本
        const hasSource = this.repository.listObservations(bankId).length > 0
            || this.repository.listUnits(bankId).some(u => u.state === 'valid' && (u.factType === 'world' || u.factType === 'experience'));
        if (!hasSource) {
            this.lastRefreshAt.set(bankId, nowSec0);
            return 0;
        }
        this.refreshingBanks.add(bankId);
        try {
            const now = Math.floor(Date.now() / 1000);
            let updated = 0;
            for (const model of models) {
                const result = await this.reflect(bankId, model.question);
                const text = (result.text || '').trim();
                if (!text || text === NO_MEMORY_TEXT) continue;
                if (text === model.answer) continue;
                // 旧答案入历史（最多保留 10 条），并记录最近刷新时间与触发方式
                model.history = [...(model.history || []), { answer: model.answer, at: now, trigger: model.trigger || 'full' }].slice(-10);
                model.answer = text;
                model.updatedAt = now;
                model.lastRefreshedAt = now;
                model.trigger = 'full';
                model.version++;
                this.repository.updateMentalModel(bankId, model);
                updated++;
            }
            return updated;
        } finally {
            this.refreshingBanks.delete(bankId);
            this.lastRefreshAt.set(bankId, Math.floor(Date.now() / 1000));
        }
    }

    // ===== Reflect =====

    async reflect(bankId: string, query: string): Promise<ReflectResult> {
        const mentalModels = this.repository.listMentalModels(bankId);
        const observations = this.repository.listObservations(bankId);
        const memories = (await this.recall(bankId, query, { types: ['world', 'experience'], maxTokens: 4096 }))
            .map(r => r.unit);
        let text = '';
        if (this.reflectSynthesizer) {
            try {
                text = (await this.reflectSynthesizer(query, { mentalModels, observations, memories })) || '';
            } catch {
                text = '';
            }
        }
        if (!text.trim()) {
            text = [
                ...mentalModels.map(m => `【心智模型】${m.question}\n${m.answer}`),
                ...observations.map(o => `【观察】${o.text}`),
                ...memories.map(m => `【事实】${m.text}`),
            ].join('\n') || NO_MEMORY_TEXT;
        }
        return {
            text,
            basedOn: { mentalModels, observations, memories },
        };
    }

    // ===== Utility =====


    /** 存量回填：为尚无向量的有效记忆惰性补算 embedding（每轮限量，失败自动降级） */
    private async backfillEmbeddings(bankId: string, units: MemoryUnit[]): Promise<void> {
        const missing = units.filter(u => u.state === 'valid' && u.embedding.length === 0);
        if (missing.length === 0) return;
        const batch = missing.slice(0, BACKFILL_BATCH_LIMIT);
        const vectors = await Promise.all(batch.map(u => this.embedText(u.text)));
        const bank = this.repository.getBank(bankId);
        if (!bank) return;
        let changed = false;
        for (let i = 0; i < batch.length; i++) {
            const vector = vectors[i];
            if (vector.length > 0) {
                const idx = bank.units.findIndex(u => u.id === batch[i].id);
                if (idx >= 0) {
                    bank.units[idx] = { ...bank.units[idx], embedding: vector };
                    changed = true;
                }
            }
        }
        if (changed) this.repository.save(bankId);
    }

    private async embedText(text: string): Promise<number[]> {
        if (!this.embedding || !text) return [];
        try {
            const v = await this.embedding(text);
            return Array.isArray(v) ? v : [];
        } catch {
            return [];
        }
    }

    private resolveEntityIds(bankId: string, names: string[]): string[] {
        const ids: string[] = [];
        const now = Math.floor(Date.now() / 1000);
        for (const raw of names) {
            const name = String(raw || '').trim();
            if (!name) continue;
            let entity = this.repository.findEntityByName(bankId, name);
            if (!entity) {
                entity = {
                    id: generateId(),
                    bankId,
                    canonicalName: name,
                    aliases: [],
                    entityType: undefined,
                    metadata: {},
                    firstSeen: now,
                    lastSeen: now,
                    mentionCount: 1,
                };
                this.repository.addEntity(bankId, entity);
            } else {
                entity.lastSeen = now;
                entity.mentionCount++;
                if (!entity.aliases.includes(name) && normalizeName(entity.canonicalName) !== normalizeName(name)) {
                    entity.aliases.push(name);
                }
                this.repository.updateEntity(bankId, entity);
            }
            ids.push(entity.id);
        }
        return ids;
    }

    private filterByTags(units: MemoryUnit[], tags: string[], match: 'any' | 'all' | 'exact'): MemoryUnit[] {
        if (!tags.length) return units;
        return units.filter(u => {
            if (match === 'exact') {
                return tags.length === u.tags.length && tags.every(t => u.tags.includes(t));
            }
            if (match === 'all') return tags.every(t => u.tags.includes(t));
            return tags.some(t => u.tags.includes(t));
        });
    }

    private semanticLimit(budget: string): number {
        return budget === 'high' ? 100 : budget === 'low' ? 20 : 50;
    }

    private keywordLimit(budget: string): number {
        return budget === 'high' ? 100 : budget === 'low' ? 20 : 50;
    }

    private keywordScore(text: string, query: string): number {
        if (!query) return 0;
        const tokens = tokenize(query);
        const grams = buildCharNGrams(query);
        let score = 0;
        if (tokens.length) {
            score += tokens.filter(t => text.includes(t)).length / tokens.length;
        }
        if (grams.size) {
            const textGrams = buildCharNGrams(text);
            if (textGrams.size) {
                let hit = 0;
                for (const g of grams) if (textGrams.has(g)) hit++;
                score += hit / grams.size;
            }
        }
        return score;
    }

    private graphSearch(bankId: string, query: string, budget: string): string[] {
        const bank = this.repository.getBank(bankId);
        if (!bank) return [];
        const qNames = tokenize(query);
        const entityIds = bank.entities
            .filter(e => qNames.some(t => normalizeName(e.canonicalName).includes(normalizeName(t)) || e.aliases.some(a => normalizeName(a).includes(normalizeName(t)))))
            .map(e => e.id);
        if (!entityIds.length) return [];
        const direct = bank.units.filter(u => u.state === 'valid' && u.entityIds.some(id => entityIds.includes(id))).map(u => u.id);
        const hops = budget === 'high' ? 3 : budget === 'low' ? 1 : 2;
        const seen = new Set<string>(direct);
        const frontier = new Set(direct);
        for (let h = 0; h < hops; h++) {
            const next = new Set<string>();
            for (const unitId of frontier) {
                for (const link of bank.links) {
                    if (link.fromUnitId === unitId && !seen.has(link.toUnitId)) next.add(link.toUnitId);
                    if (link.toUnitId === unitId && !seen.has(link.fromUnitId)) next.add(link.fromUnitId);
                }
            }
            for (const id of next) seen.add(id);
            frontier.clear();
            for (const id of next) frontier.add(id);
        }
        return Array.from(seen);
    }

    private temporalSearch(units: MemoryUnit[], query: string): string[] {
        const window = parseTemporalWindow(query);
        if (!window) return [];
        const inWindow = units.filter(u => {
            const start = u.occurredStart ?? u.mentionedAt ?? 0;
            const end = u.occurredEnd ?? u.occurredStart ?? u.mentionedAt ?? start;
            return end >= window.start && start <= window.end;
        });
        return inWindow.map(u => u.id);
    }

    private rrf(lists: Array<{ strategy: string; ids: string[] }>): Array<[string, number]> {
        const scores = new Map<string, number>();
        for (const list of lists) {
            list.ids.forEach((id, idx) => {
                const rank = idx + 1;
                scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank));
            });
        }
        return Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1]);
    }

    private matchedStrategies(lists: Array<{ strategy: string; ids: string[] }>, id: string): string[] {
        return lists.filter(l => l.ids.includes(id)).map(l => l.strategy);
    }

    private pushResult(results: RecallResult[], usedTokens: Map<string, number>, item: RecallResult, maxTokens: number): void {
        const cost = estimateTokens(item.unit.text);
        const used = Array.from(usedTokens.values()).reduce((a, b) => a + b, 0);
        if (maxTokens > 0 && used + cost > maxTokens) return;
        results.push(item);
        usedTokens.set(item.unit.id, cost);
    }

    /** 召回命中：更新访问计数与最近访问时间（新近度加分的依据）；只改内存不落盘，由 recall 末尾统一 save */
    private touchUnit(bankId: string, unit: MemoryUnit): void {
        const now = Math.floor(Date.now() / 1000);
        // 以库中最新对象为准（backfill 可能已替换为带向量的新对象），避免回写覆盖
        const current = this.repository.getUnit(bankId, unit.id) || unit;
        current.accessCount = (current.accessCount || 0) + 1;
        current.lastAccessedAt = now;
        this.repository.updateUnit(bankId, current, false);
    }

    private sameCluster(a: MemoryUnit, b: MemoryUnit): boolean {
        const sharedEntities = a.entityIds.some(id => b.entityIds.includes(id));
        if (sharedEntities) return true;
        const sharedTags = a.tags.some(t => b.tags.includes(t) && (t.startsWith('user:') || t.startsWith('group:')));
        if (sharedTags) return true;
        return textSimilarity(a.text, b.text) >= 0.6;
    }
}

function tokenize(s: string): string[] {
    return Array.from(new Set(String(s || '').split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(t => t.length > 0)));
}

function simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
}

function estimateTokens(text: string): number {
    let cjk = 0;
    let other = 0;
    for (const ch of String(text || '')) {
        if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
        else if (ch.trim()) other++;
    }
    return cjk + Math.ceil(other / 4);
}

function textSimilarity(a: string, b: string): number {
    const ga = buildCharNGrams(a || '');
    const gb = buildCharNGrams(b || '');
    if (!ga.size || !gb.size) return 0;
    let hit = 0;
    for (const g of ga) if (gb.has(g)) hit++;
    return hit / Math.min(ga.size, gb.size);
}

function parseTemporalWindow(query: string): { start: number; end: number } | null {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();
    const startOfDay = new Date(year, month, day).getTime();
    if (/今年|本年/.test(query)) return { start: new Date(year, 0, 1).getTime(), end: now.getTime() };
    if (/去年/.test(query)) return { start: new Date(year - 1, 0, 1).getTime(), end: new Date(year - 1, 11, 31, 23, 59, 59).getTime() };
    if (/上个月|上月/.test(query)) return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime() - 1 };
    if (/这个月|本月/.test(query)) return { start: new Date(year, month, 1).getTime(), end: now.getTime() };
    if (/今天|今日/.test(query)) return { start: startOfDay, end: now.getTime() };
    if (/昨天/.test(query)) return { start: startOfDay - 86400000, end: startOfDay - 1 };
    if (/前天/.test(query)) return { start: startOfDay - 2 * 86400000, end: startOfDay - 86400000 - 1 };
    const m = query.match(/(\d{4})年(\d{1,2})月/);
    if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        return { start: new Date(y, mo - 1, 1).getTime(), end: new Date(y, mo, 1).getTime() - 1 };
    }
    return null;
}
