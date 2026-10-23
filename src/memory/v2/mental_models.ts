// 心智模型服务（叶子）：创建/删除/固定模板补建/刷新（staleness gating、delta 窗口、失败冷却）/触发配置归一化。
// 从 memory/v2/engine.ts 拆出——只依赖 repository、时钟、reflect 与向量补算回调（由 MemoryEngine 注入），
// 刷新限流与防重入状态随服务迁移；engine.ts 保留同名公开方法委派。
import { generateId } from "../../utils/id";

import type { MemoryRepository } from "./repository";
import {
    LEGACY_PERSONA_QUESTION,
    mentalModelTemplatesFor,
    personaQuestionFor,
    TEMPLATE_VERSION,
} from "./templates";
import type {
    FactType,
    MentalModel,
    MentalModelRefreshReason,
    MentalModelRefreshSummary,
    MentalModelTemplateId,
    MentalModelTrigger,
    MentalModelTriggerConfig,
    ReflectResult,
} from "./types";

/** 心智模型占位答案：无答案创建时的 pending 文案（不作为 delta 基线/有效答案） */
const PENDING_ANSWER = '生成中…';
const NO_MEMORY_TEXT = '暂无足够记忆进行推理';

/** 心智模型服务所需的最小宿主视图（MemoryEngine 注入） */
export interface MentalModelHost {
    repository: MemoryRepository;
    nowSec(): number;
    /** 反思调用（engine.reflect），用于按问题生成答案 */
    reflect(bankId: string, question: string, opts: any): Promise<ReflectResult>;
    /** 计算并落库心智模型语义向量（engine.computeMentalModelEmbedding，best-effort） */
    computeEmbedding(bankId: string, model: MentalModel): Promise<void>;
}

export class MentalModelService {
    private host: MentalModelHost;
    /** 正在刷新心智模型的 bank（防重入） */
    private refreshingBanks = new Set<string>();
    /** 自动刷新最小间隔（秒），0 为不限制 */
    private refreshMinIntervalSec = 0;
    /** 各 bank 最近一次自动刷新时间（秒） */
    private lastRefreshAt = new Map<string, number>();
    /** 心智模型默认刷新模式（未显式指定时） */
    private defaultMode: MentalModelTrigger = 'full';
    /** 心智模型刷新时默认是否排除其它心智模型 */
    private defaultExcludeMentalModels = true;

    constructor(host: MentalModelHost) {
        this.host = host;
    }

    private get repository(): MemoryRepository {
        return this.host.repository;
    }

    /** 自动刷新最小间隔（秒）：consolidate 后的自动刷新受此限流，0 为不限制 */
    setRefreshMinInterval(seconds: number): void {
        this.refreshMinIntervalSec = seconds > 0 ? seconds : 0;
    }

    /** 配置心智模型默认刷新参数（createMentalModel 未显式指定时生效） */
    setDefaults(opts: { mode?: MentalModelTrigger; excludeMentalModels?: boolean }): void {
        if (opts.mode === 'full' || opts.mode === 'delta') this.defaultMode = opts.mode;
        if (typeof opts.excludeMentalModels === 'boolean') this.defaultExcludeMentalModels = opts.excludeMentalModels;
    }

    /** 各 bank 最近一次心智模型自动刷新时间（秒），供定时 tick 判断是否到点 */
    getLastAutoRefreshAt(bankId: string): number {
        return this.lastRefreshAt.get(bankId) || 0;
    }

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
        const now = this.host.nowSec();
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
            if (answer) this.host.computeEmbedding(bankId, existing).catch(() => { });
            return existing;
        }
        const mode = opts.mode || this.defaultMode;
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
        if (answer) this.host.computeEmbedding(bankId, model).catch(() => { });
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
        const now = this.host.nowSec();
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
                    this.host.computeEmbedding(bankId, twin).catch(() => { });
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
        const now0 = this.host.nowSec();
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
            this.lastRefreshAt.set(bankId, this.host.nowSec());
        }
    }

    /** 刷新单条心智模型：返回 updated / skipped(reason) / failed */
    private async refreshOneMentalModel(
        bankId: string,
        model: MentalModel,
        opts: { force: boolean; reason: MentalModelRefreshReason }
    ): Promise<{ status: 'updated' | 'skipped' | 'failed'; reason?: string }> {
        const now = this.host.nowSec();
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
            result = await this.host.reflect(bankId, model.question, {
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
            this.host.computeEmbedding(bankId, model).catch(() => { });
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
}
