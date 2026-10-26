// 心智模型服务：创建/模板播种/刷新（full|delta）/搜索/删除。
// 默认值对齐 Hindsight：mode=full、refreshAfterConsolidation=false、minInterval=0、maxTokens=2048、48h delta full。
import { generateId } from "../../utils/id";

import type { MemoryRepository } from "./repository";
import { applyDeltaOps, parseMarkdown, renderMarkdown } from "./structured";
import { LEGACY_PERSONA_QUESTION, mentalModelTemplatesFor, personaQuestionFor, TEMPLATE_VERSION } from "./templates";
import type {
    DeltaOperator,
    FactType,
    MentalModel,
    MentalModelRefreshReason,
    MentalModelRefreshSummary,
    MentalModelTemplateId,
    MentalModelTrigger,
    ReflectResult,
    TagsMatch,
} from "./types";

const DEFAULT_MAX_TOKENS = 2048;
const FAILED_COOLDOWN_SEC = 30 * 60;
const DELTA_FULL_REBUILD_SEC = 48 * 60 * 60;

export interface MentalModelHost {
    repository: MemoryRepository;
    nowSec(): number;
    reflect(bankId: string, question: string, opts: Record<string, unknown>): Promise<ReflectResult>;
    deltaOps?: DeltaOperator;
    embed?: (text: string) => Promise<number[]>;
}

export class MentalModelService {
    private host: MentalModelHost;
    private refreshMinIntervalSec = 0;
    private defaultMaxTokens = DEFAULT_MAX_TOKENS;
    private failedCooldownSec = FAILED_COOLDOWN_SEC;
    private deltaFullRebuildSec = DELTA_FULL_REBUILD_SEC;
    private defaultMode: MentalModelTrigger = 'full';
    private excludeSiblings = true;
    private lastAutoRefreshAt = new Map<string, number>();

    constructor(host: MentalModelHost) {
        this.host = host;
    }

    private get repository(): MemoryRepository { return this.host.repository; }

    setRefreshMinInterval(seconds: number): void { this.refreshMinIntervalSec = seconds > 0 ? seconds : 0; }
    setMaxTokens(tokens: number): void { this.defaultMaxTokens = tokens > 0 ? tokens : DEFAULT_MAX_TOKENS; }
    setFailedCooldown(seconds: number): void { this.failedCooldownSec = seconds > 0 ? seconds : FAILED_COOLDOWN_SEC; }
    setDeltaFullRebuild(seconds: number): void { this.deltaFullRebuildSec = seconds > 0 ? seconds : DELTA_FULL_REBUILD_SEC; }
    setDefaults(opts: { mode?: MentalModelTrigger; excludeMentalModels?: boolean }): void {
        if (opts.mode === 'full' || opts.mode === 'delta') this.defaultMode = opts.mode;
        if (typeof opts.excludeMentalModels === 'boolean') this.excludeSiblings = opts.excludeMentalModels;
    }
    getLastAutoRefreshAt(bankId: string): number { return this.lastAutoRefreshAt.get(bankId) || 0; }

    listMentalModels(bankId: string): MentalModel[] { return this.repository.listMentalModels(bankId); }

    async createMentalModel(
        bankId: string,
        sourceQuery: string,
        answer: string,
        tags: string[] = [],
        opts: {
            mode?: MentalModelTrigger;
            autoRefresh?: boolean;
            factTypes?: FactType[];
            templateId?: MentalModelTemplateId;
        } = {},
    ): Promise<MentalModel> {
        const now = this.host.nowSec();
        const existing = this.repository.listMentalModels(bankId).find(m => m.sourceQuery === sourceQuery);
        const content = String(answer || '').trim();
        if (existing) {
            if (content) {
                existing.content = content;
                existing.structuredContent = parseMarkdown(content);
                existing.status = 'ready';
                existing.lastRefreshedAt = now;
                existing.lastFullRefreshAt = now;
                existing.lastMemorySeenSeq = this.maxInScopeSeq(bankId, existing);
            }
            if (tags.length) existing.tags = tags;
            if (opts.mode) existing.trigger.mode = opts.mode;
            if (opts.factTypes) existing.trigger.factTypes = opts.factTypes;
            if (opts.templateId) existing.templateId = opts.templateId;
            if (opts.autoRefresh !== undefined) existing.trigger.refreshAfterConsolidation = opts.autoRefresh;
            existing.updatedAt = now;
            this.repository.updateMentalModel(bankId, existing, true);
            return existing;
        }
        const model: MentalModel = {
            id: generateId(),
            bankId,
            sourceQuery,
            content,
            structuredContent: parseMarkdown(content),
            trigger: {
                mode: opts.mode || this.defaultMode,
                refreshAfterConsolidation: opts.autoRefresh ?? false,
                factTypes: opts.factTypes || ['world', 'experience'],
                tagsMatch: tags.length ? 'all_strict' : 'any',
            },
            tags,
            maxTokens: this.defaultMaxTokens,
            status: content ? 'ready' : 'pending',
            createdAt: now,
            updatedAt: now,
            lastRefreshedAt: content ? now : 0,
            lastFullRefreshAt: content ? now : 0,
            lastRefreshedSourceQuery: sourceQuery,
            lastMemorySeenSeq: 0,
            history: [],
            embedding: [],
            templateId: opts.templateId,
        };
        if (content) {
            model.lastMemorySeenSeq = this.maxInScopeSeq(bankId, model);
        }
        this.repository.addMentalModel(bankId, model, true);
        await this.computeEmbedding(model);
        return model;
    }

    async deleteMentalModel(bankId: string, id: string): Promise<void> {
        this.repository.deleteMentalModel(bankId, id, true);
    }

    /** 版本化播种固定模板；返回需要 seed refresh 的模型 id（含历史遗留 pending）。 */
    async ensureDefaultMentalModels(bankId: string, kind: 'user' | 'group' | 'global', scopeTag: string, enabled: boolean): Promise<string[]> {
        if (!enabled) return [];
        const bank = this.repository.getOrCreateBank(bankId, kind);
        const seededVersion = bank.meta.settings.seededMentalModelVersion || 0;
        const alreadyCurrent = seededVersion >= TEMPLATE_VERSION;
        const targets = mentalModelTemplatesFor(kind);
        const seedIds: string[] = [];
        for (const tpl of targets) {
            const existing = this.repository.listMentalModels(bankId).find(m => m.templateId === tpl.id);
            if (existing) {
                // 无来源事实时不要空转 seed job；有新的来源事实才排队
                if (existing.status === 'pending' && this.maxInScopeSeq(bankId, existing) > existing.lastMemorySeenSeq) {
                    seedIds.push(existing.id);
                }
                continue;
            }
            // 已经完成过当前模板版本：删除后不自动复活（只有版本升级才补新模板）
            if (alreadyCurrent) continue;
            const model = await this.createMentalModel(bankId, tpl.question, '', scopeTag ? [scopeTag] : [], {
                templateId: tpl.id,
                autoRefresh: false,
            });
            seedIds.push(model.id);
        }
        if (seededVersion < TEMPLATE_VERSION) {
            bank.meta.settings.seededMentalModelVersion = TEMPLATE_VERSION;
            this.repository.markDirty(bankId, 'meta');
            this.repository.save(bankId, ['meta']);
        }
        return seedIds;
    }

    async refreshMentalModels(
        bankId: string,
        id: string | undefined,
        opts: { force?: boolean; reason?: MentalModelRefreshReason; touchedTags?: string[]; ids?: string[] } = {},
    ): Promise<MentalModelRefreshSummary & { seedIds: string[] }> {
        const summary: MentalModelRefreshSummary & { seedIds: string[] } = {
            updated: 0, skipped: 0, failed: 0, skippedReasons: {}, refreshedIds: [], seedIds: [],
        };
        let models = this.repository.listMentalModels(bankId);
        if (opts.ids?.length) {
            const set = new Set(opts.ids);
            models = models.filter(m => set.has(m.id));
        } else if (id) {
            models = models.filter(m => m.id === id);
        }
        const touched = new Set(opts.touchedTags || []);
        if (touched.size) {
            models = models.filter(m => m.tags.length === 0 || m.tags.some(t => touched.has(t)));
        }
        for (const model of models) {
            const result = await this.refreshOne(bankId, model, !!opts.force, opts.reason || 'manual');
            if (result.status === 'updated') { summary.updated++; summary.refreshedIds.push(model.id); }
            else if (result.status === 'failed') summary.failed++;
            else {
                summary.skipped++;
                const reason = result.reason || 'skipped';
                summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1;
            }
        }
        return summary;
    }

    async refreshMentalModel(bankId: string, id: string, opts: { force?: boolean; reason?: MentalModelRefreshReason } = {}): Promise<MentalModelRefreshSummary> {
        return this.refreshMentalModels(bankId, id, opts);
    }

    private async refreshOne(bankId: string, model: MentalModel, force: boolean, reason: MentalModelRefreshReason): Promise<{ status: 'updated' | 'skipped' | 'failed'; reason?: string }> {
        const now = this.host.nowSec();
        const cfg = model.trigger;
        const cooldown = model.status === 'failed' && model.lastFailedAt && now - model.lastFailedAt < this.failedCooldownSec;
        if (!force && cooldown) return { status: 'skipped', reason: 'failed_cooldown' };

        const newSeq = this.maxInScopeSeq(bankId, model);
        if (!force && newSeq <= model.lastMemorySeenSeq) return { status: 'skipped', reason: 'not_stale' };
        if (!force && this.refreshMinIntervalSec > 0 && model.lastRefreshedAt > 0 && now - model.lastRefreshedAt < this.refreshMinIntervalSec) {
            return { status: 'skipped', reason: 'interval' };
        }

        const scopeTags = model.tags;
        const baselineOk = model.structuredContent.sections.length > 0
            && model.sourceQuery === model.lastRefreshedSourceQuery;
        const deltaDue = cfg.mode === 'delta' && baselineOk && this.host.deltaOps && !force;
        const deltaTooOld = cfg.mode === 'delta' && now - (model.lastFullRefreshAt || 0) >= this.deltaFullRebuildSec;

        try {
            let content = '';
            let structured = model.structuredContent;
            let basedOn: ReflectResult['basedOn'] = { mentalModels: [], observations: [], memories: [] };
            const excludeMentalModelIds = this.excludeSiblings
                ? this.repository.listMentalModels(bankId).filter(m => m.id !== model.id).map(m => m.id)
                : [];
            if (deltaDue && !deltaTooOld) {
                const hits = await this.host.reflect(bankId, model.sourceQuery, {
                    scopeTags, factTypes: cfg.factTypes, strict: true, maxTokens: model.maxTokens,
                    createdAfterSeq: model.lastMemorySeenSeq, fastPath: false, excludeMentalModelIds,
                });
                const evidence = hits.basedOn.memories.map(m => m.text);
                basedOn = hits.basedOn;
                const ops = await this.host.deltaOps!({ sourceQuery: model.sourceQuery, structured, evidence });
                if (!ops.length) throw new Error('delta_empty');
                const applied = applyDeltaOps(structured, ops);
                if (applied.applied === 0) throw new Error('delta_noop');
                structured = applied.doc;
                content = renderMarkdown(structured);
            } else {
                const result = await this.host.reflect(bankId, model.sourceQuery, {
                    scopeTags, factTypes: cfg.factTypes, strict: true, maxTokens: model.maxTokens, fastPath: false,
                    excludeMentalModelIds,
                });
                content = result.text || '';
                basedOn = result.basedOn;
                structured = parseMarkdown(content);
            }
            if (!content.trim()) {
                model.reflectResponse = { at: now, basedOn: { mentalModelIds: [], observationIds: [], memoryIds: [] }, skipped: 'empty_candidate' };
                this.repository.updateMentalModel(bankId, model, true);
                return { status: 'skipped', reason: 'empty_candidate' };
            }
            model.history.push({ content: model.content, at: now, trigger: reason === 'seed' ? 'seed' : (deltaDue && !deltaTooOld ? 'delta' : 'full') });
            if (model.history.length > 10) model.history = model.history.slice(-10);
            model.content = content;
            model.structuredContent = structured;
            model.status = 'ready';
            model.updatedAt = now;
            model.lastRefreshedAt = now;
            model.lastRefreshedSourceQuery = model.sourceQuery;
            model.lastMemorySeenSeq = newSeq;
            if (!deltaDue || deltaTooOld) model.lastFullRefreshAt = now;
            model.reflectResponse = { at: now, basedOn: { mentalModelIds: basedOn.mentalModels.map(m => m.id), observationIds: basedOn.observations.map(o => o.id), memoryIds: basedOn.memories.map(m => m.id) } };
            await this.computeEmbedding(model);
            this.repository.updateMentalModel(bankId, model, true);
            this.lastAutoRefreshAt.set(bankId, now);
            const meta = this.repository.getBankMeta(bankId);
            if (meta) {
                meta.settings.lastAutoRefreshAt = now;
                this.repository.markDirty(bankId, 'meta');
            }
            return { status: 'updated' };
        } catch {
            model.status = 'failed';
            model.lastFailedAt = now;
            this.repository.updateMentalModel(bankId, model, true);
            return { status: 'failed', reason: 'llm_error' };
        }
    }

    private async computeEmbedding(model: MentalModel): Promise<void> {
        if (!this.host.embed) return;
        try {
            const vec = await this.host.embed(`${model.sourceQuery}\n${model.content}`);
            if (vec.length) model.embedding = vec;
        } catch { /* ignore */ }
    }

    /** scope 内最新 fact seq（factTypes/tags 过滤；tagsMatch all_strict 时要求全 tags）。 */
    maxInScopeSeq(bankId: string, model: MentalModel): number {
        const bank = this.repository.getBank(bankId);
        if (!bank) return 0;
        const tags = model.tags;
        const match = model.trigger.tagsMatch;
        const facts = bank.units.filter(u => u.state === 'valid' && model.trigger.factTypes.includes(u.factType) && matchesTags(u.tags, tags, match));
        return facts.reduce((max, u) => Math.max(max, u.createdAtSeq || 0), 0);
    }

    searchMentalModels(bankId: string, query: string, tags: string[] = []): Array<{ model: MentalModel; score: number; stale: boolean }> {
        const scope = new Set(tags);
        const models = this.repository.listMentalModels(bankId)
            .filter(m => m.status === 'ready')
            .filter(m => m.tags.length === 0 || m.tags.some(t => scope.has(t)));
        return models
            .map(model => ({
                model,
                score: scoreModel(model, query),
                stale: this.maxInScopeSeq(bankId, model) > model.lastMemorySeenSeq,
            }))
            .sort((a, b) => b.score - a.score);
    }

    isStale(bankId: string, model: MentalModel): boolean {
        return this.maxInScopeSeq(bankId, model) > model.lastMemorySeenSeq;
    }
}

function matchesTags(unitTags: string[], tags: string[], match: TagsMatch): boolean {
    if (!tags.length) return true;
    if (match === 'exact') return tags.length === unitTags.length && tags.every(t => unitTags.includes(t));
    if (match === 'all' || match === 'all_strict') return tags.every(t => unitTags.includes(t));
    return tags.some(t => unitTags.includes(t));
}

function scoreModel(model: MentalModel, query: string): number {
    if (!query) return 0.5;
    const q = query.toLowerCase();
    const text = `${model.sourceQuery}\n${model.content}`.toLowerCase();
    if (!q) return 0.5;
    const tokens = q.split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(Boolean);
    if (!tokens.length) return 0.5;
    const hit = tokens.filter(t => text.includes(t)).length / tokens.length;
    return 0.3 + hit * 0.7;
}

export { LEGACY_PERSONA_QUESTION, personaQuestionFor };
