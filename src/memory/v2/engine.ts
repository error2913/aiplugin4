// Hindsight-like 记忆引擎：Retain / Recall / Consolidation / Reflect 的纯 TS 实现。
// 设计参考 Hindsight：MemoryUnit + Entity + MemoryLink + Observation + MentalModel。
import { generateId } from "../../utils/id";
import { cosineSimilarity } from "../../utils/similarity";

import { doConsolidate, pruneBank as pruneBankImpl } from "./consolidation";
import { MemoryRepository, normalizeName } from "./repository";
import { estimateTokens, filterByTags, keywordLimit, keywordScore, matchedStrategies, rrf, SEMANTIC_SIMILARITY_THRESHOLD, semanticLimit, simpleHash, temporalSearch, tokenize } from "./scoring";
import { InMemoryMemoryStorage, MemoryStorage } from "./storage";
import {
    LEGACY_PERSONA_QUESTION,
    mentalModelTemplatesFor,
    personaQuestionFor,
    TEMPLATE_VERSION,
} from "./templates";
import type {
    ConsolidationResult,
    FactExtractor,
    FactType,
    MemoryBankMeta,
    MemoryUnit,
    MentalModel,
    MentalModelRefreshReason,
    MentalModelRefreshSummary,
    MentalModelTemplateId,
    MentalModelTrigger,
    MentalModelTriggerConfig,
    ObservationSynthesizer,
    RecallOptions,
    RecallResult,
    ReflectResult,
    ReflectSynthesizer,
    Reranker,
    RetainInput,
    RetainResult,
} from "./types";

const DEFAULT_MAX_TOKENS = 2048;
const BACKFILL_BATCH_LIMIT = 20;
const NO_MEMORY_TEXT = '暂无足够记忆进行推理';
/** 心智模型占位答案：无答案创建时的 pending 文案（不作为 delta 基线/有效答案） */
const PENDING_ANSWER = '生成中…';

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
    /** 长期记忆条数上限（0 = 不限制，默认 100 由配置注入） */
    memoryCap?: number;
    /** 可注入时钟（返回秒级时间戳），测试用；默认 Date.now()/1000 */
    now?: () => number;
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
    /** 长期记忆条数上限（0 = 不限制） */
    private memoryCap = 0;
    /** 时钟（秒级时间戳），测试可注入 */
    private nowFn: () => number;
    /** 心智模型默认刷新模式（未显式指定时） */
    private defaultMentalModelMode: MentalModelTrigger = 'full';
    /** 心智模型刷新时默认是否排除其它心智模型 */
    private defaultExcludeMentalModels = true;
    constructor(options: MemoryEngineOptions = {}) {
        this.repository = new MemoryRepository(options.storage || new InMemoryMemoryStorage());
        this.embedding = options.embedding;
        this.extract = options.extract;
        this.rerank = options.rerank;
        this.synthesizeObservation = options.synthesizeObservation;
        this.reflectSynthesizer = options.reflectSynthesizer;
        this.recencyWeight = options.recencyWeight ?? 0.4;
        this.recencyHalfLifeDays = options.recencyHalfLifeDays ?? 60;
        this.memoryCap = options.memoryCap ?? 0;
        this.nowFn = options.now || (() => Math.floor(Date.now() / 1000));
    }

    /** 秒级当前时间（统一走可注入时钟） */
    private nowSec(): number {
        return this.nowFn();
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

    /** 配置长期记忆条数上限：cap<=0 为不限制（默认 100 由 createMemoryEngine 注入） */
    setMemoryCap(cap: number): void {
        this.memoryCap = cap > 0 ? cap : 0;
    }

    /** 配置心智模型默认刷新参数（createMentalModel 未显式指定时生效） */
    setMentalModelDefaults(opts: { mode?: MentalModelTrigger; excludeMentalModels?: boolean }): void {
        if (opts.mode === 'full' || opts.mode === 'delta') this.defaultMentalModelMode = opts.mode;
        if (typeof opts.excludeMentalModels === 'boolean') this.defaultExcludeMentalModels = opts.excludeMentalModels;
    }

    /** 各 bank 最近一次心智模型自动刷新时间（秒），供定时 tick 判断是否到点 */
    getLastAutoRefreshAt(bankId: string): number {
        return this.lastRefreshAt.get(bankId) || 0;
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
        const entityIds = this.resolveEntityIds(bankId, input.entities || [], false);
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
        this.repository.addUnit(bankId, unit, false);

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
                }, false);
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
                    }, false);
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
            }, false);
            this.repository.addChunk(bankId, {
                id: `${input.documentId}_${unitId}`,
                documentId: input.documentId,
                bankId,
                text,
                embedding: unit.embedding.length ? unit.embedding : undefined,
            }, false);
        }

        // 遗忘机制：超限时按覆盖/衰减优先级物理删除多余记忆（上限为硬约束）
        await this.pruneBank(bankId, false);

        // 批量写穿：retain 全程 persist=false 累计变更，末尾统一落盘一次
        this.repository.save(bankId);
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
        units = filterByTags(units, opts.tags || [], opts.tagsMatch || 'any');

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
                .slice(0, semanticLimit(opts.budget || 'mid'));
            strategyResults.push({ strategy: 'semantic', ids: ranked.map(r => r.id) });
        }

        // 2. Keyword / BM25-like
        const keywordRanked = units
            .map(u => ({ id: u.id, score: keywordScore(u.text, q) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, keywordLimit(opts.budget || 'mid'));
        strategyResults.push({ strategy: 'keyword', ids: keywordRanked.map(r => r.id) });

        // 3. Graph
        const graphIds = this.graphSearch(bankId, q, opts.budget || 'mid');
        if (graphIds.length > 0) strategyResults.push({ strategy: 'graph', ids: graphIds });

        // 4. Temporal
        const temporalIds = temporalSearch(units, q);
        if (temporalIds.length > 0) strategyResults.push({ strategy: 'temporal', ids: temporalIds });

        let rrfEntries = rrf(strategyResults);
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
                        this.pushResult(results, usedTokens, { unit: obsUnit, score: rrfScoreValue, matchedStrategies: matchedStrategies(strategyResults, id) }, opts.maxTokens || DEFAULT_MAX_TOKENS);
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
                matchedStrategies: matchedStrategies(strategyResults, id),
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
            const result = await doConsolidate({ repository: this.repository, synthesizeObservation: this.synthesizeObservation }, bankId);
            // 遗忘机制：consolidate 后大量细节已被 observation 覆盖，覆盖优先物理删（上限硬约束）
            // doConsolidate 末尾已统一落盘一次；若 pruneBank 实际淘汰了单元，须再落盘一次，否则淘汰只停留在内存、重载后复活
            const evicted = await this.pruneBank(bankId, false);
            if (evicted.length > 0) this.repository.save(bankId);
            return result;
        } finally {
            this.consolidatingBanks.delete(bankId);
        }
    }




    /** 淘汰包装：参数化实现见 ./consolidation.pruneBank（上限来自实例配置 memoryCap） */
    private async pruneBank(bankId: string, persist = true): Promise<string[]> {
        return pruneBankImpl(this.repository, this.memoryCap, bankId, persist);
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



    // ===== Mental Models =====

    listMentalModels(bankId: string): MentalModel[] {
        return this.repository.listMentalModels(bankId);
    }

    async createMentalModel(
        bankId: string,
        question: string,
        answer: string,
        scopeTags: string[] = [],
        opts: {
            mode?: MentalModelTrigger;
            autoRefresh?: boolean;
            factTypes?: FactType[];
            excludeMentalModels?: boolean;
            templateId?: MentalModelTemplateId;
        } = {}
    ): Promise<MentalModel> {
        const now = this.nowSec();
        const existing = this.repository.listMentalModels(bankId).find(m => m.question === question);
        if (existing) {
            const mode = opts.mode || existing.triggerConfig?.mode || 'full';
            const hadAnswer = !!(existing.answer && existing.answer !== PENDING_ANSWER);
            if (answer) {
                // 手写覆盖：内容更新（版本+1），向量清空待重算
                existing.answer = answer;
                existing.status = 'ready';
                existing.lastMemorySeenAt = now;
                existing.version++;
                existing.embedding = [];
            } else if (!hadAnswer) {
                // 原本无有效答案（空/占位）：保持待生成语义；版本由成功刷新推进，避免双跳
                existing.answer = '';
                existing.status = 'pending';
                existing.lastMemorySeenAt = 0;
                existing.embedding = [];
            }
            // 已有旧答案 + 无答案 add = 重新生成语义：保留旧答案/watermark/版本作失败兜底，
            // 只更新 scope/刷新配置，成功与否由 refresh 路径负责
            existing.scopeTags = scopeTags;
            existing.updatedAt = now;
            if (typeof existing.lastRefreshedAt !== 'number') existing.lastRefreshedAt = now;
            if (!Array.isArray(existing.history)) existing.history = [];
            existing.trigger = mode;
            existing.triggerConfig = {
                mode,
                refreshAfterConsolidation: opts.autoRefresh !== undefined
                    ? opts.autoRefresh !== false
                    : existing.triggerConfig?.refreshAfterConsolidation ?? true,
                excludeMentalModels: opts.excludeMentalModels ?? existing.triggerConfig?.excludeMentalModels ?? this.defaultExcludeMentalModels,
                factTypes: opts.factTypes ?? existing.triggerConfig?.factTypes,
            };
            existing.lastFailedAt = undefined;
            if (opts.templateId) existing.templateId = opts.templateId;
            this.repository.updateMentalModel(bankId, existing);
            // 同问题覆盖手写答案：embedding 已清空，异步重算（失败静默），避免语义召回失效
            if (answer) this.computeMentalModelEmbedding(bankId, existing).catch(() => { });
            return existing;
        }
        const mode = opts.mode || this.defaultMentalModelMode;
        const model: MentalModel = {
            id: generateId(),
            bankId,
            question,
            answer: answer || PENDING_ANSWER,
            scopeTags,
            createdAt: now,
            updatedAt: now,
            version: 1,
            lastRefreshedAt: now,
            history: [],
            trigger: mode,
            triggerConfig: {
                mode,
                refreshAfterConsolidation: opts.autoRefresh !== false,
                excludeMentalModels: opts.excludeMentalModels ?? this.defaultExcludeMentalModels,
                factTypes: opts.factTypes,
            },
            status: answer ? 'ready' : 'pending',
            lastMemorySeenAt: answer ? now : 0,
            embedding: [],
            templateId: opts.templateId,
        };
        this.repository.addMentalModel(bankId, model);
        // 手写答案：best-effort 异步算向量（不阻塞、失败静默），供注入语义排序/召回使用
        if (answer) this.computeMentalModelEmbedding(bankId, model).catch(() => { });
        return model;
    }

    deleteMentalModel(bankId: string, id: string): boolean {
        return this.repository.deleteMentalModel(bankId, id);
    }

    /**
     * 固定心智模型补建与旧 persona 问题迁移：
     * - 旧合体问题（这个用户/群的设定是什么？）按 kind 原地改名到专属问题并标记 templateId=persona；
     *   新旧两条并存时把旧答案并入新条（新条无有效内容时）后删除旧条
     * - 版本门：seededMentalModelVersion 推进后不再补旧模板 → 用户删除内置模型后不会自动复活；
     *   模板版本升级（TEMPLATE_VERSION+1）只增量补新条目
     * - 有源才补建：bank 尚无有效记忆/观察时等待（避免空库 pending 占位污染 .ai memo mm list）
     */
    ensureDefaultMentalModels(
        bankId: string,
        kind: 'user' | 'group',
        scopeTag: string
    ): { created: number; renamed: number } {
        const bank = this.repository.getBank(bankId);
        if (!bank) return { created: 0, renamed: 0 };
        const now = this.nowSec();
        let renamed = 0;
        const targetQuestion = personaQuestionFor(kind);
        const legacyModels = bank.mentalModels.filter(m => m.question === LEGACY_PERSONA_QUESTION);
        for (const legacy of legacyModels) {
            const twin = bank.mentalModels.find(x => x.id !== legacy.id && x.question === targetQuestion);
            if (twin) {
                const legacyAnswer = legacy.answer && legacy.answer !== PENDING_ANSWER ? legacy.answer : '';
                const twinEmpty = !twin.answer || twin.answer === PENDING_ANSWER;
                if (legacyAnswer && twinEmpty) {
                    twin.answer = legacyAnswer;
                    twin.status = 'ready';
                    twin.updatedAt = now;
                    twin.version++;
                    twin.embedding = [];
                    this.computeMentalModelEmbedding(bankId, twin).catch(() => { });
                }
                twin.history = [...(twin.history || []), ...(legacy.history || [])].slice(-10);
                twin.templateId = 'persona';
                if (typeof twin.lastRefreshedAt !== 'number') twin.lastRefreshedAt = twin.updatedAt;
                if (typeof twin.lastMemorySeenAt !== 'number') twin.lastMemorySeenAt = legacy.lastMemorySeenAt || 0;
                this.repository.updateMentalModel(bankId, twin);
                bank.mentalModels = bank.mentalModels.filter(x => x.id !== legacy.id);
            } else {
                legacy.question = targetQuestion;
                legacy.templateId = 'persona';
                legacy.updatedAt = now;
            }
            renamed++;
        }
        if (renamed > 0) this.repository.save(bankId);

        const settings = bank.meta.settings;
        const seeded = typeof settings.seededMentalModelVersion === 'number' ? settings.seededMentalModelVersion : 0;
        if (seeded >= TEMPLATE_VERSION) return { created: 0, renamed };
        const hasSource = bank.observations.length > 0 || bank.units.some(u => u.state === 'valid');
        if (!hasSource) return { created: 0, renamed };

        let created = 0;
        for (const tpl of mentalModelTemplatesFor(kind)) {
            const existing = bank.mentalModels.find(m => m.question === tpl.question);
            if (!existing) {
                this.createMentalModel(bankId, tpl.question, '', [scopeTag], { templateId: tpl.id });
                created++;
            } else if (!existing.templateId) {
                existing.templateId = tpl.id;
                this.repository.updateMentalModel(bankId, existing);
            }
        }
        settings.seededMentalModelVersion = TEMPLATE_VERSION;
        this.repository.save(bankId);
        return { created, renamed };
    }

    /**
     * 刷新心智模型（Hindsight refresh_mental_model 的 TS 版）：per-model 管线。
     * - scope：factTypes + scopeTags 过滤；排除自身（默认还排除其它心智模型）
     * - staleness gating：非 force 且 scope 内无新记忆（> lastMemorySeenAt）时跳过，不调 LLM
     * - watermark：成功后 lastMemorySeenAt 推进到快照内最新记忆时间；失败不推进
     * - delta：只喂 createdAfter=lastMemorySeenAt 窗口内的新记忆 + 旧答案做增量更新
     * 返回 {updated, skipped, failed, skippedReasons, refreshedIds}。
     */
    async refreshMentalModels(
        bankId: string,
        id?: string,
        opts: { force?: boolean; reason?: MentalModelRefreshReason } = {}
    ): Promise<MentalModelRefreshSummary> {
        const summary: MentalModelRefreshSummary = { updated: 0, skipped: 0, failed: 0, skippedReasons: {}, refreshedIds: [] };
        // 防重入：同一 bank 正在刷新时直接跳过，避免并发重复调用
        if (this.refreshingBanks.has(bankId)) return summary;
        // 最小间隔限流：自动刷新（非 force）受「心智模型刷新最小间隔」配置限制
        const now0 = this.nowSec();
        if (!opts.force && this.refreshMinIntervalSec > 0) {
            const last = this.lastRefreshAt.get(bankId) || 0;
            if (last > 0 && now0 - last < this.refreshMinIntervalSec) return summary;
        }
        const models = this.repository.listMentalModels(bankId).filter(m => !id || m.id === id);
        if (models.length === 0) return summary;
        // 空库短路：无任何有效记忆/观察时不调 LLM（pending 保持 pending，不烧 token）
        const bank0 = this.repository.getBank(bankId);
        const hasSource = !!bank0 && (bank0.observations.length > 0
            || bank0.units.some(u => u.state === 'valid' && (u.factType === 'world' || u.factType === 'experience')));
        if (!hasSource) {
            this.lastRefreshAt.set(bankId, now0);
            for (let i = 0; i < models.length; i++) this.bumpSkip(summary, 'no_source');
            return summary;
        }
        this.refreshingBanks.add(bankId);
        try {
            for (const model of models) {
                const outcome = await this.refreshOneMentalModel(bankId, model, {
                    force: !!opts.force,
                    reason: opts.reason || 'manual',
                });
                if (outcome.status === 'updated') {
                    summary.updated++;
                    summary.refreshedIds.push(model.id);
                } else if (outcome.status === 'skipped') {
                    this.bumpSkip(summary, outcome.reason || 'skipped');
                } else {
                    summary.failed++;
                }
            }
            return summary;
        } finally {
            this.refreshingBanks.delete(bankId);
            this.lastRefreshAt.set(bankId, this.nowSec());
        }
    }

    /** 刷新单条心智模型：返回 updated / skipped(reason) / failed */
    private async refreshOneMentalModel(
        bankId: string,
        model: MentalModel,
        opts: { force: boolean; reason: MentalModelRefreshReason }
    ): Promise<{ status: 'updated' | 'skipped' | 'failed'; reason?: string }> {
        const now = this.nowSec();
        const cfg = this.resolveTriggerConfig(model);
        const bank = this.repository.getBank(bankId);
        if (!bank) return { status: 'skipped', reason: 'no_bank' };

        // per-model 自动刷新开关：consolidate/tick 触发的自动刷新跳过 refreshAfterConsolidation=false 的模型
        // （用户手写/FAQ 类模型，--no-auto；manual/create 强制路径不受影响）
        if (!opts.force && (opts.reason === 'consolidate' || opts.reason === 'tick') && cfg.refreshAfterConsolidation === false) {
            return { status: 'skipped', reason: 'auto_off' };
        }

        // 失败冷却：failed 模型在冷却期内自动刷新跳过，避免反复烧 token（冷却默认复用最小间隔，未配置则 30 分钟）
        if (!opts.force && model.status === 'failed' && model.lastFailedAt) {
            const cooldown = this.refreshMinIntervalSec > 0 ? this.refreshMinIntervalSec : 1800;
            if (now - model.lastFailedAt < cooldown) return { status: 'skipped', reason: 'failed_cooldown' };
        }

        // scope 解析：factTypes + scopeTags（空 scopeTags=全局放行，any 命中）；observation 直接读 observation 对象
        const factTypes: FactType[] = cfg.factTypes && cfg.factTypes.length > 0
            ? cfg.factTypes
            : ['world', 'experience', 'observation'];
        const scopeTags = model.scopeTags || [];
        const tagMatch = (tags: string[] | undefined): boolean => {
            const t = tags || [];
            if (scopeTags.length === 0) return true;
            return t.some(x => scopeTags.includes(x));
        };
        const factUnits = bank.units.filter(u => u.state === 'valid'
            && u.factType !== 'observation'
            && factTypes.includes(u.factType)
            && tagMatch(u.tags));
        const obsList = factTypes.includes('observation') ? bank.observations.filter(o => tagMatch(o.scopeTags)) : [];

        // watermark 快照：scope 内最新记忆时间（world/experience 用 unit.updatedAt，observation 用 observation.updatedAt）
        const newest = Math.max(
            0,
            ...factUnits.map(u => u.updatedAt || u.createdAt || 0),
            ...obsList.map(o => o.updatedAt || o.createdAt || 0),
        );
        if (newest === 0) return { status: 'skipped', reason: 'no_source' };

        // staleness gating：scope 内没有比上次见过更新的记忆 → 跳过，不调 LLM
        const seenAt = model.lastMemorySeenAt || 0;
        if (!opts.force && seenAt > 0 && newest <= seenAt) return { status: 'skipped', reason: 'not_stale' };

        // delta 窗口：只读上次刷新之后的新记忆
        const createdAfter = cfg.mode === 'delta' && seenAt > 0 ? seenAt : undefined;

        // 排除自身（默认还排除其它心智模型，避免模型间互相引用/自我强化）
        const excludeIds = [model.id];
        if (cfg.excludeMentalModels !== false) {
            for (const other of bank.mentalModels) if (other.id !== model.id) excludeIds.push(other.id);
        }

        let result: ReflectResult;
        try {
            result = await this.reflect(bankId, model.question, {
                factTypes,
                scopeTags,
                excludeMentalModelIds: excludeIds,
                createdAfter,
                mode: cfg.mode,
                // delta 基线：占位文本不算基线（无基线时回退全量重写）
                existingAnswer: cfg.mode === 'delta' && model.answer && model.answer !== PENDING_ANSWER ? model.answer : undefined,
                strict: true,
                maxTokens: 4096,
            });
        } catch {
            return this.markRefreshFailed(bankId, model, now);
        }
        const text = (result.text || '').trim();
        if (!text || text === NO_MEMORY_TEXT || text === PENDING_ANSWER) {
            return this.markRefreshFailed(bankId, model, now);
        }

        const changed = text !== model.answer;
        // failed 状态恢复且内容未变也算有效更新：状态从「不注入」变「注入」，
        // 需让调用方（updated>0）推进 memory revision 缓存失效
        const recovered = !changed && model.status === 'failed';
        if (changed) {
            model.history = [...(model.history || []), { answer: model.answer, at: now, trigger: cfg.mode }].slice(-10);
            model.answer = text;
            model.version++;
            model.updatedAt = now;
        }
        // watermark 推进：成功（含"无变化"）即推进，避免空窗口反复触发
        model.lastRefreshedAt = now;
        model.lastMemorySeenAt = newest;
        model.status = 'ready';
        model.lastFailedAt = undefined;
        model.trigger = cfg.mode;
        model.triggerConfig = cfg;
        this.repository.updateMentalModel(bankId, model);
        // 内容变化/状态恢复/向量缺失时补算 embedding，兜底历史遗留无向量模型
        if (changed || recovered || !model.embedding || model.embedding.length === 0) {
            this.computeMentalModelEmbedding(bankId, model).catch(() => { });
        }
        return changed || recovered ? { status: 'updated' } : { status: 'skipped', reason: 'unchanged' };
    }

    /** 刷新失败：保留旧答案、不推进 watermark、记录失败时间（供冷却重试） */
    private markRefreshFailed(
        bankId: string,
        model: MentalModel,
        now: number
    ): { status: 'failed'; reason: string } {
        model.status = 'failed';
        model.lastFailedAt = now;
        this.repository.updateMentalModel(bankId, model);
        return { status: 'failed', reason: 'empty' };
    }

    /** 归一化心智模型触发配置（旧数据缺省字段兜底） */
    private resolveTriggerConfig(model: MentalModel): MentalModelTriggerConfig {
        const t = model.triggerConfig;
        return {
            mode: t?.mode === 'delta' ? 'delta' : 'full',
            refreshAfterConsolidation: t?.refreshAfterConsolidation !== false,
            excludeMentalModels: t?.excludeMentalModels !== false,
            factTypes: Array.isArray(t?.factTypes) && (t?.factTypes?.length ?? 0) > 0 ? t!.factTypes!.slice() : undefined,
        };
    }

    /** 跳过原因计数 */
    private bumpSkip(summary: MentalModelRefreshSummary, reason: string): void {
        summary.skipped++;
        summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1;
    }

    /** 计算查询向量（未配置 embedding 或失败返回 null），供注入语义排序复用，避免每库各算一次 */
    async embedQuery(text: string): Promise<number[] | null> {
        const q = String(text || '').trim();
        if (!q) return null;
        const v = await this.embedText(q);
        return v && v.length > 0 ? v : null;
    }

    /**
     * 心智模型语义召回（Hindsight 心智模型参与检索的 TS 版）：只返回 ready，
     * 按 query 相关度排序（语义向量优先，关键词兜底，最后更新时间兜底）。
     * 传入 queryEmbedding 可复用同一查询向量（注入场景每轮只算一次）。
     */
    async searchMentalModels(
        bankId: string,
        query: string,
        opts: { tags?: string[]; limit?: number; queryEmbedding?: number[] | null; excludeTemplates?: boolean } = {}
    ): Promise<MentalModel[]> {
        const models = this.repository.listMentalModels(bankId)
            .filter(m => m.status === 'ready' || m.status === undefined)
            .filter(m => !(opts.excludeTemplates && m.templateId))
            .filter(m => {
                if (!opts.tags || opts.tags.length === 0) return true;
                const tags = m.scopeTags || [];
                if (tags.length === 0) return true; // 全局心智模型放行
                return tags.some(t => opts.tags!.includes(t));
            });
        if (models.length === 0) return [];
        const q = String(query || '').trim();
        const qv = opts.queryEmbedding !== undefined
            ? (opts.queryEmbedding || [])
            : (q ? await this.embedText(q) : []);
        const scored = models.map(m => {
            let score = 0;
            if (qv.length > 0 && m.embedding && m.embedding.length > 0) {
                score = Math.max(score, cosineSimilarity(qv, m.embedding));
            }
            if (q) {
                // 关键词兜底：无向量或向量未命中时仍可按 question/answer 命中排序
                score = Math.max(score, keywordScore(`${m.question} ${m.answer}`, q) * 0.5);
            }
            return { m, score };
        });
        scored.sort((a, b) => b.score - a.score || (b.m.updatedAt || 0) - (a.m.updatedAt || 0));
        return scored.slice(0, opts.limit ?? 5).map(x => x.m);
    }

    /** 计算并落库心智模型语义向量（best-effort，失败静默） */
    private async computeMentalModelEmbedding(bankId: string, model: MentalModel): Promise<void> {
        const vec = await this.embedText(`${model.question} ${model.answer}`);
        if (!vec || vec.length === 0) return;
        const current = this.repository.getBank(bankId)?.mentalModels.find(m => m.id === model.id);
        if (!current) return;
        current.embedding = vec;
        this.repository.updateMentalModel(bankId, current);
    }

    // ===== Reflect =====

    async reflect(
        bankId: string,
        query: string,
        opts: {
            factTypes?: FactType[];
            scopeTags?: string[];
            excludeMentalModelIds?: string[];
            createdAfter?: number;
            mode?: MentalModelTrigger;
            existingAnswer?: string;
            strict?: boolean;
            maxTokens?: number;
            scopeNote?: string;
        } = {}
    ): Promise<ReflectResult> {
        const bank = this.repository.getBank(bankId);
        const exclude = new Set(opts.excludeMentalModelIds || []);
        const mentalModels = (bank ? bank.mentalModels : [])
            .filter(m => !exclude.has(m.id) && (m.status === 'ready' || m.status === undefined));
        const observations = (bank ? bank.observations : [])
            .filter(o => {
                if (opts.scopeTags && opts.scopeTags.length) {
                    const tags = o.scopeTags || [];
                    if (!tags.some(t => opts.scopeTags!.includes(t))) return false;
                }
                if (opts.createdAfter && (o.updatedAt || 0) <= opts.createdAfter) return false;
                return true;
            });
        // 事实类记忆走 recall；observation 由 observations 列表单独提供，避免 unit 与 observation 双重注入
        const unitTypes = (opts.factTypes || ['world', 'experience', 'observation']).filter(t => t !== 'observation');
        const memories = (await this.recall(bankId, query, {
            types: unitTypes.length > 0 ? unitTypes : ['world', 'experience'],
            tags: opts.scopeTags || [],
            maxTokens: opts.maxTokens || 4096,
        }))
            .map(r => r.unit)
            .filter(u => !opts.createdAfter || (u.updatedAt || 0) > opts.createdAfter);
        let text = '';
        if (this.reflectSynthesizer) {
            try {
                text = (await this.reflectSynthesizer(query, {
                    mentalModels,
                    observations,
                    memories,
                    existingAnswer: opts.existingAnswer,
                    mode: opts.mode,
                    scopeNote: opts.scopeNote || this.scopeNoteForBank(bankId),
                })) || '';
            } catch {
                text = '';
            }
        }
        if (!text.trim()) {
            if (opts.strict) {
                // 刷新路径：禁止把记忆原文/心智模型 dump 成"答案"（避免把占位文本/记忆清单写进心智模型）
                text = '';
            } else {
                text = [
                    ...mentalModels.map(m => `【心智模型】${m.question}\n${m.answer}`),
                    ...observations.map(o => `【观察】${o.text}`),
                    ...memories.map(m => `【事实】${m.text}`),
                ].join('\n') || NO_MEMORY_TEXT;
            }
        }
        return {
            text,
            basedOn: { mentalModels, observations, memories },
        };
    }

    /** 由 bankId（user_/group_ 前缀 + 平台前缀 ID）生成 reflect 范围提示行 */
    private scopeNoteForBank(bankId: string): string {
        const sep = bankId.indexOf('_');
        const prefix = sep > 0 ? bankId.slice(0, sep) : '';
        const raw = sep > 0 ? bankId.slice(sep + 1) : bankId;
        const kindLabel = prefix === 'group' ? '群聊' : prefix === 'user' ? '私聊' : '会话';
        const colon = raw.indexOf(':');
        const platform = colon > 0 ? raw.slice(0, colon) : '';
        return platform
            ? `当前范围：平台=${platform}，会话=${kindLabel} ${raw}`
            : `当前范围：会话=${kindLabel} ${raw}`;
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

    private resolveEntityIds(bankId: string, names: string[], persist = true): string[] {
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
                this.repository.addEntity(bankId, entity, persist);
            } else {
                entity.lastSeen = now;
                entity.mentionCount++;
                if (!entity.aliases.includes(name) && normalizeName(entity.canonicalName) !== normalizeName(name)) {
                    entity.aliases.push(name);
                }
                this.repository.updateEntity(bankId, entity, persist);
            }
            ids.push(entity.id);
        }
        return ids;
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




}





