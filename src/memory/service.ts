// 记忆统一门面：命令/工具/注入/调度都只经过这里。
import Config from "../config/config";
import { getAuxLlm } from "../core/ports/aux_llm";
import type { Session } from "../session/session";
import { normalizeGroupId, normalizeUserId } from "../utils/target_id";

import { bumpMemoryRevision, bumpSummaryRevision } from "./revision";
import { bankKindOf, canReadByTags, getOriginScope, getVisibility, globalScopeName, sanitizeExternalTags, uniq, type ViewerContext, visibilityTag } from "./v2/access";
import { buildExtractPrompt } from "./v2/extract_prompt";
import {
    DEFAULT_MEMORY_PROMPT_TOKENS,
    type MemoryPromptSection,
    buildMemoryPrompt as renderMemoryPrompt,
    selectInjectionCandidates,
} from "./v2/prompt";
import { distinctLiveEvidence, normalizeName } from "./v2/repository";
import { estimateTokens } from "./v2/scoring";
import { personaQuestionFor } from "./v2/templates";
import type {
    BankKind,
    ConsolidateOutcome,
    ExtractOutcome,
    FactType,
    MemoryBankMeta,
    MemoryStatus,
    MemoryUnit,
    MentalModel,
    MentalModelRefreshReason,
    MentalModelRefreshSummary,
    Observation,
    RecallHit,
    RecallOptions,
    ReflectResult,
    RetainInput,
    RetainResult,
} from "./v2/types";

export interface SessionRef {
    sessionId: string;
    agentName?: string;
    sessionType?: 'user' | 'group';
}

export interface RetainForSessionInput extends Partial<RetainInput> {
    content: string;
    relatedUserIds?: string[];
    relatedGroupIds?: string[];
    keywords?: string[];
    visibility?: 'public' | 'private' | 'origin' | 'owner';
    metadata?: Record<string, string>;
    importance?: number;
    type?: string;
    /** origin 可见性的来源会话；缺省为 bank 自身会话 */
    originScope?: string;
}

type SeedHook = (bankId: string, modelIds: string[]) => void;
let seedHook: SeedHook | null = null;
export function setMentalModelSeedHook(fn: SeedHook | null): void { seedHook = fn; }

let engineFactory: (() => any) | null = null;
let engine: any = null;
export function setMemoryEngineFactory(factory: () => any): void {
    engineFactory = factory;
    engine = null;
}
function getEngine(): any {
    if (!engine) engine = engineFactory ? engineFactory() : null;
    if (!engine) throw new Error('MemoryEngine 未初始化');
    return engine;
}

export function getMemoryEngineInstance(): any {
    return getEngine();
}

/** 配置变更后重建引擎（存储不变）。 */
export function resetMemoryEngineInstance(): void {
    engine = null;
}

export class MemoryService {
    static ensureBank(bankId: string, kind?: BankKind, agentName = ''): MemoryBankMeta {
        const k = kind || bankKindOf(bankId);
        getEngine().ensureBank(bankId, k, agentName, k === 'global' ? undefined : rawSessionId(bankId));
        return getEngine().repository.getOrCreateBank(bankId, k, agentName).meta;
    }

    static bankIdForSessionId(sessionId: string, _agentName = '*'): string {
        const kind: BankKind = /-Group:/.test(sessionId) ? 'group' : 'user';
        return `${kind}_${sessionId}`;
    }

    static globalBankId(agentName = '*'): string {
        return `global_${agentName === '*' ? 'main' : agentName}`;
    }

    /** 写入：服务层强制注入 scope/visibility/source 标签。 */
    static async retainForSession(session: Session, input: RetainForSessionInput): Promise<RetainResult> {
        const bankId = this.bankIdForSessionId(session.sessionId, session.agentName);
        return this.retainToBank(bankId, input, session.agentName);
    }

    static async retainForSessionId(sessionId: string, agentName: string, input: RetainForSessionInput): Promise<RetainResult> {
        return this.retainToBank(this.bankIdForSessionId(sessionId, agentName), input, agentName);
    }

    /** 直接写指定 bank：命令/工具跨目标写入的唯一入口。 */
    static async retainToBank(bankId: string, input: RetainForSessionInput, agentName = '*'): Promise<RetainResult> {
        if (!configBool('MEMORY_ENABLED', true)) return { unitIds: [], action: 'noop' };
        const kind = bankKindOf(bankId);
        this.ensureBank(bankId, kind, agentName);
        const tags = this.buildTags(bankId, kind, input);
        const result = await getEngine().retain(bankId, {
            content: input.content,
            tags,
            metadata: input.metadata,
            factType: input.factType,
            entities: input.entities,
            occurredStart: input.occurredStart,
            occurredEnd: input.occurredEnd,
            importance: input.importance,
        });
        if (result.action === 'added') bumpMemoryRevision();
        return result;
    }

    static buildTags(bankId: string, kind: BankKind, input: RetainForSessionInput): string[] {
        const combined = uniq([
            ...(input.tags || []),
            ...(input.relatedUserIds || []).map(id => `user:${normalizeUserId(id) || id}`),
            ...(input.relatedGroupIds || []).map(id => `group:${normalizeGroupId(id) || id}`),
        ]);
        const external = sanitizeExternalTags(combined);
        const scope = kind === 'global' ? `global:${rawSessionId(bankId)}` : kind === 'group' ? `group:${rawSessionId(bankId)}` : `user:${rawSessionId(bankId)}`;
        const vis = kind === 'global' || kind === 'group' ? 'public'
            : input.visibility === 'private' || input.visibility === 'owner' ? 'owner'
                : input.visibility === 'origin' ? 'origin'
                    : input.visibility === 'public' ? 'public' : 'owner';
        const tags = [scope, visibilityTag(vis, input.originScope || rawSessionId(bankId)), ...external];
        return uniq(tags);
    }

    // ===== 抽取（LLM 只做 facts；路由/写入在本层） =====

    static async extractFromChunk(session: Session, chunk: { text: string; throughSeq: number; textLength: number }, source: 'ai' | 'archive' | 'manual' = 'ai'): Promise<ExtractOutcome> {
        const content = String(chunk?.text || '').trim();
        if (!content || !configBool('MEMORY_ENABLED', true)) return { touchedBanks: [], factsAdded: 0, factsInvalidated: 0, factsDropped: 0, touchedTags: [] };
        const facts = await this.extractFacts(session, content);
        const outcome: ExtractOutcome = { touchedBanks: [], factsAdded: 0, factsInvalidated: 0, factsDropped: 0, touchedTags: [] };
        const touched = new Set<string>();
        for (const fact of facts) {
            const applied = await this.applyFact(session, fact, source);
            outcome.factsAdded += applied.added;
            outcome.factsInvalidated += applied.invalidated;
            outcome.factsDropped += applied.dropped ? 1 : 0;
            for (const bank of applied.banks) touched.add(bank);
            for (const tag of applied.tags) outcome.touchedTags.push(tag);
        }
        outcome.touchedBanks = Array.from(touched);
        outcome.touchedTags = uniq(outcome.touchedTags);
        if (outcome.factsAdded || outcome.factsInvalidated) bumpMemoryRevision();
        if (session.sessionId) {
            const meta = getEngine().repository.getBankMeta(this.bankIdForSessionId(session.sessionId, session.agentName));
            if (meta) {
                meta.settings.lastExtractAt = Math.floor(Date.now() / 1000);
                getEngine().repository.markDirty(meta.id, 'meta');
            }
        }
        return outcome;
    }

    private static async extractFacts(session: Session, content: string): Promise<any[]> {
        const isPrivate = !/-Group:/.test(session.sessionId);
        const sessionId = session.sessionId;
        const rawId = sessionId.replace(/^.+:/, '');
        const prompt = buildExtractPrompt({
            platform: sessionId.split(':')[0] || '',
            isPrivate,
            userName: isPrivate ? rawId : '',
            userId: rawId,
            groupName: isPrivate ? '' : rawId,
            groupId: rawId,
            content,
            globalEnabled: configBool('EXTRACT_GLOBAL', false),
            personalFromGroup: configBool('EXTRACT_PERSONAL_FROM_GROUP', false),
        });
        const reply = await getAuxLlm().chat('summarize_agent', prompt);
        const data = safeJson(reply);
        if (!data || !Array.isArray(data.facts)) throw new Error('extract_invalid_json');
        return data.facts;
    }

    private static async applyFact(session: Session, fact: any, source: 'ai' | 'archive' | 'manual'): Promise<{ added: number; invalidated: number; dropped: boolean; banks: string[]; tags: string[] }> {
        const text = String(fact?.text || '').trim();
        if (!text) return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
        const op = fact.op === 'update' ? 'update' : fact.op === 'delete' ? 'delete' : fact.op === 'noop' ? 'noop' : 'add';
        if (op === 'noop') return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
        const memoryType = fact.memory_type === 'global' ? 'global' : fact.memory_type === 'group' ? 'group' : 'private';
        const isPrivateSession = !/-Group:/.test(session.sessionId);
        const platform = session.sessionId.split(':')[0] || '';
        const conf = Number(fact.confidence ?? 1);
        const visibility = fact.visibility === 'origin' ? 'origin' : fact.visibility === 'owner' || fact.visibility === 'private' ? 'owner' : 'public';
        const keywords = Array.isArray(fact.keywords) ? sanitizeExternalTags(fact.keywords.map(String)) : [];
        const relatedUsers = Array.isArray(fact.related_user_ids) ? fact.related_user_ids.map(String) : [];
        const relatedGroups = Array.isArray(fact.related_group_ids) ? fact.related_group_ids.map(String) : [];

        let bankId = '';
        let kind: BankKind = 'user';
        let vis = visibility as 'public' | 'owner' | 'origin';
        const tags: string[] = [];
        if (memoryType === 'global') {
            if (!configBool('EXTRACT_GLOBAL', false)) return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
            if (isPrivateSession || conf < 0.6 || containsUserRef(text)) return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
            kind = 'global';
            bankId = this.globalBankId(session.agentName);
            vis = 'public';
            tags.push(`global:${globalScopeName(session.agentName)}`);
        } else if (memoryType === 'group') {
            kind = 'group';
            const target = normalizeGroupId(fact.target_id, platform) || (/-Group:/.test(session.sessionId) ? session.sessionId : '');
            if (!target) return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
            if (!/-Group:/.test(session.sessionId) || target !== session.sessionId) {
                return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
            }
            bankId = `group_${target}`;
            vis = 'public';
            tags.push(`group:${target}`);
        } else {
            kind = 'user';
            let targetUser = normalizeUserId(fact.target_id, platform) || '';
            if (!targetUser && isPrivateSession) targetUser = session.sessionId;
            if (!targetUser) {
                // 群聊中无法确定目标：退回当前群 bank（origin），不写个人
                bankId = `group_${session.sessionId}`;
                kind = 'group';
                vis = 'origin';
                tags.push(`group:${session.sessionId}`);
            } else {
                if (/-Group:/.test(session.sessionId) && !configBool('EXTRACT_PERSONAL_FROM_GROUP', false)) {
                    bankId = `group_${session.sessionId}`;
                    kind = 'group';
                    vis = 'origin';
                    tags.push(`group:${session.sessionId}`);
                } else {
                    bankId = `user_${targetUser}`;
                    vis = isPrivateSession ? 'owner' : 'origin';
                    // 群聊来源的个人事实默认仅来源群 + 本人 DM 可见；显式 public 必须走命令/工具的跨群开关
                    tags.push(`user:${targetUser}`);
                }
            }
        }
        const originScope = /-Group:/.test(session.sessionId) ? session.sessionId : (isPrivateSession ? session.sessionId : '');
        const sourceTag = /-Group:/.test(session.sessionId) ? `src:group:${session.sessionId}` : `src:dm:${session.sessionId}`;
        const finalTags = uniq([
            ...tags,
            ...(kind === 'global' ? [] : [visibilityTag(vis, originScope)]),
            sourceTag,
            ...relatedUsers.map(id => `user:${normalizeUserId(id) || id}`),
            ...relatedGroups.map(id => `group:${normalizeGroupId(id) || id}`),
            ...keywords,
        ]);
        const repo = getEngine().repository;
        repo.getOrCreateBank(bankId, kind, session.agentName);

        if (op === 'delete' || op === 'update') {
            const existingId = String(fact.existing_id || '');
            const existing = existingId ? repo.getUnit(bankId, existingId) : null;
            if (!existing) {
                if (op === 'delete') return { added: 0, invalidated: 0, dropped: true, banks: [], tags: [] };
            } else {
                existing.state = 'invalidated';
                existing.invalidatedAt = Math.floor(Date.now() / 1000);
                existing.invalidatedBy = session.sessionId;
                if (existing.consolidationState === 'pending') {
                    existing.consolidationState = 'done';
                }
                repo.updateUnit(bankId, existing, false);
                repo.setPendingCount(bankId);
            }
            if (op === 'delete') {
                repo.setPendingCount(bankId);
                const bank = repo.getBank(bankId);
                if (bank) for (const obs of bank.observations) obs.proofCount = distinctLiveEvidence(bank, obs.evidence);
                repo.save(bankId, ['units', 'obs', 'meta']);
                return { added: 0, invalidated: existing ? 1 : 0, dropped: false, banks: [bankId], tags: finalTags };
            }
        }

        const result = await getEngine().retain(bankId, {
            content: text,
            tags: finalTags,
            metadata: { type: fact.type || 'text', source, supersedes: fact.existing_id ? String(fact.existing_id) : '' },
            supersedes: fact.existing_id ? String(fact.existing_id) : undefined,
            factType: fact.type === 'event' ? 'experience' : 'world',
            entities: Array.isArray(fact.entities) ? fact.entities.map(String) : [],
            occurredStart: parseOccurredAt(fact.occurred_at),
            importance: typeof fact.importance === 'number' ? fact.importance : 0.5,
        });
        for (const relatedId of Array.isArray(fact.related_memory_ids) ? fact.related_memory_ids : []) {
            const from = result.unitIds[0];
            if (from) repo.addLink(bankId, { fromUnitId: from, toUnitId: String(relatedId), linkType: 'related', weight: 1, createdAt: Math.floor(Date.now() / 1000) });
        }
        const bank = repo.getBank(bankId);
        if (bank) {
            for (const obs of bank.observations) obs.proofCount = distinctLiveEvidence(bank, obs.evidence);
        }
        repo.save(bankId, ['units', 'links', 'obs', 'meta']);
        return { added: result.action === 'added' ? 1 : 0, invalidated: op === 'update' ? 1 : 0, dropped: false, banks: [bankId], tags: finalTags };
    }

    // ===== 读 =====

    static listFacts(bankId: string, includeInvalidated = false): MemoryUnit[] {
        return getEngine().repository.listUnits(bankId).filter((u: MemoryUnit) => includeInvalidated || u.state === 'valid');
    }

    static listFactIds(bankId: string): string[] {
        return this.listFacts(bankId).map(u => u.id);
    }

    static pendingCount(bankId: string): number {
        const meta = getEngine().repository.getBankMeta(bankId);
        return meta?.settings.pendingFactCount || 0;
    }

    static getFact(bankId: string, id: string): MemoryUnit | null {
        return getEngine().repository.getUnit(bankId, id);
    }

    static saveFact(bankId: string, unit: MemoryUnit): void {
        getEngine().repository.updateUnit(bankId, unit, true);
        bumpMemoryRevision();
    }

    static async invalidateFacts(bankId: string, ids: string[]): Promise<number> {
        const repo = getEngine().repository;
        const now = Math.floor(Date.now() / 1000);
        let n = 0;
        for (const id of ids) {
            const unit = repo.getUnit(bankId, id);
            if (!unit || unit.state === 'invalidated') continue;
            unit.state = 'invalidated';
            unit.invalidatedAt = now;
            repo.updateUnit(bankId, unit, false);
            n++;
        }
        if (n) {
            const bank = repo.getBank(bankId);
            if (bank) {
                for (const obs of bank.observations) obs.proofCount = distinctLiveEvidence(bank, obs.evidence);
            }
            repo.setPendingCount(bankId);
            repo.save(bankId, ['units', 'obs', 'meta']);
            bumpMemoryRevision();
        }
        return n;
    }

    static listObservations(bankId: string): Observation[] {
        return getEngine().repository.listObservations(bankId);
    }

    static getObservation(bankId: string, id: string): Observation | null {
        return getEngine().repository.getObservation(bankId, id);
    }

    static async clearObservations(bankId: string): Promise<number> {
        const repo = getEngine().repository;
        const obs = repo.listObservations(bankId);
        for (const o of obs) repo.deleteObservation(bankId, o.id);
        for (const unit of repo.listUnits(bankId)) unit.consolidationState = 'pending';
        repo.setPendingCount(bankId);
        repo.save(bankId, ['units', 'obs', 'meta']);
        bumpSummaryRevision();
        return obs.length;
    }

    static listMentalModels(bankId: string): MentalModel[] {
        return getEngine().listMentalModels(bankId);
    }

    static async createMentalModel(bankId: string, question: string, answer: string, tags: string[] = [], opts: {
        mode?: 'full' | 'delta'; autoRefresh?: boolean; factTypes?: FactType[];
    } = {}): Promise<MentalModel> {
        return getEngine().createMentalModel(bankId, question, answer, tags, opts);
    }

    static saveMentalModel(bankId: string, model: MentalModel): void {
        getEngine().repository.updateMentalModel(bankId, model, true);
        bumpMemoryRevision();
    }

    static async deleteMentalModel(bankId: string, id: string): Promise<void> {
        await getEngine().deleteMentalModel(bankId, id);
    }

    static async recall(bankId: string, options: RecallOptions): Promise<RecallHit[]> {
        return getEngine().recall(bankId, options);
    }

    static async recallForSessionId(sessionId: string, agentName: string, query: string, options: Partial<RecallOptions> = {}): Promise<RecallHit[]> {
        const bankId = this.bankIdForSessionId(sessionId, agentName);
        return getEngine().recall(bankId, { query, ...options });
    }

    static async consolidateBank(bankId: string, opts: { maxFacts?: number; targetedTags?: string[] } = {}): Promise<ConsolidateOutcome> {
        const result = await getEngine().consolidate(bankId, opts);
        if (result.created.length || result.updated.length || result.merged.length) bumpSummaryRevision();
        return result;
    }

    static async refreshMentalModels(bankId: string, opts: {
        ids?: string[]; id?: string; force?: boolean; reason?: MentalModelRefreshReason; touchedTags?: string[];
    } = {}): Promise<MentalModelRefreshSummary & { seedIds?: string[] }> {
        const result = await getEngine().refreshMentalModels(bankId, opts.id, opts);
        if (result.updated > 0) bumpMemoryRevision();
        return result;
    }

    static searchMentalModelsScored(bankId: string, query: string, tags: string[] = []): Array<{ model: MentalModel; score: number; stale: boolean }> {
        return getEngine().searchMentalModels(bankId, query, tags);
    }

    static async reflect(bankId: string, query: string, opts: Parameters<typeof getEngine> extends never ? never : any = {}): Promise<ReflectResult> {
        return getEngine().reflect(bankId, query, opts);
    }

    static async ensureDefaultMentalModels(_session: Session, bankId: string, kind: BankKind, scopeTag: string): Promise<void> {
        const ids = await getEngine().ensureDefaultMentalModels(bankId, kind, scopeTag, configBool('MM_TEMPLATES', true));
        if (ids.length && seedHook) seedHook(bankId, ids);
    }

    /** 兼容旧 SessionMemoryService.persona：一次性迁入固定 persona 模型，随后清空旧字段。 */
    private static async migrateLegacyPersona(session: Session, bankId: string, kind: BankKind, scopeTag: string): Promise<void> {
        const persona = session.memory?.persona;
        if (!persona || persona === '无' || !persona.trim()) return;
        try {
            await getEngine().createMentalModel(bankId, personaQuestionFor(kind), persona, [scopeTag], { templateId: 'persona' });
            session.memory.persona = '无';
        } catch { /* 迁移失败不影响本轮注入 */ }
    }

    // ===== 注入 =====

    static async buildMemoryPrompt(session: Session, text: string, uis: Array<{ id: string; name: string }>, gi: { id: string; name: string } | null): Promise<string> {
        if (!configBool('MEMORY_ENABLED', true)) return '';
        const currentKind: BankKind = /-Group:/.test(session.sessionId) ? 'group' : 'user';
        const currentBank = currentKind === 'group' ? `group_${session.sessionId}` : `user_${session.sessionId}`;
        const scopeTag = `${currentKind}:${session.sessionId}`;
        const sessionTags = uniq([scopeTag, ...uis.map(u => `user:${u.id}`), ...(gi ? [`group:${gi.id}`] : [])]);
        await this.migrateLegacyPersona(session, currentBank, currentKind, scopeTag);
        await this.ensureDefaultMentalModels(session, currentBank, currentKind, scopeTag);
        if (configBool('GLOBAL_MEMORY_ENABLED', true)) {
            await this.ensureDefaultMentalModels(session, this.globalBankId(session.agentName), 'global', `global:${globalScopeName(session.agentName)}`);
        }

        const sections: MemoryPromptSection[] = [];
        const viewer = viewerOf(session, currentKind === 'group' ? uis[0]?.id : session.sessionId, gi?.id);
        const obsEnabled = session.memory?.observationEnabled ?? configBool('OBSERVATION_ENABLED', true);
        const current = await this.collectSections(currentBank, text, sessionTags, viewer, currentKind === 'group' ? 'group' : 'user', currentKind === 'group' ? `群聊记忆（${gi?.name || session.sessionId}）` : '个人记忆', sessionTags, obsEnabled);
        sections.push(current);

        if (currentKind === 'group') {
            for (const user of uis.slice(0, 3)) {
                const bank = `user_${user.id}`;
                const userTags = [`user:${user.id}`, ...(gi ? [`group:${gi.id}`] : [])];
                sections.push(await this.collectSections(bank, text, userTags, viewerOf(session, user.id, gi?.id), 'user', `个人记忆（${user.name || user.id}）`, userTags, obsEnabled));
            }
        }
        if (configBool('GLOBAL_MEMORY_ENABLED', true)) {
            const globalBank = this.globalBankId(session.agentName);
            const globalTags = [`global:${globalScopeName(session.agentName)}`];
            const globalSection = await this.collectSections(globalBank, text, globalTags, viewer, 'global', '本体经验（全局）', globalTags, obsEnabled);
            globalSection.maxTokens = 300;
            sections.push(globalSection);
        }
        return renderMemoryPrompt(sections, Math.max(500, configInt('MEMORY_PROMPT_TOKENS', DEFAULT_MEMORY_PROMPT_TOKENS)));
    }

    private static async collectSections(
        bankId: string,
        query: string,
        sessionTags: string[],
        viewer: ViewerContext,
        kind: 'group' | 'user' | 'global',
        title: string,
        recallTags: string[],
        includeObservations = true,
    ): Promise<MemoryPromptSection> {
        const repo = getEngine().repository;
        repo.getOrCreateBank(bankId, kind);
        const tags = recallTags.filter(t => /^(user|group|global):/.test(t));
        const models = getEngine().listMentalModels(bankId);
        const scored = getEngine().searchMentalModels(bankId, query, tags).map((x: any) => x.model);
        const fixed = models.filter((m: MentalModel) => m.templateId && m.status === 'ready');
        const selectedRaw = selectInjectionCandidates(
            mergeUnique([...fixed, ...scored]),
            repo.listObservations(bankId),
            sessionTags,
        );
        const selectedObservations = includeObservations
            ? selectedRaw.observations.filter(o => canReadByTags(bankId, o.tags, viewer))
            : [];
        const selectedModels = kind === 'user' && viewer.groupId ? [] : selectedRaw.mentalModels;
        const recalls = await getEngine().recall(bankId, {
            query,
            tags,
            tagsMatch: 'any',
            maxTokens: 1600,
            collapseObservations: includeObservations,
        });
        const selectedObs = new Set(selectedObservations.map(o => o.id));
        const filtered = recalls.filter((h: RecallHit) => (h.kind === 'observation'
            ? includeObservations && !!h.observation && canReadByTags(bankId, h.observation.tags, viewer) && !selectedObs.has(h.observation.id)
            : (h.unit && canReadByTags(h.unit.bankId, h.unit.tags, viewer))));
        return {
            kind,
            title,
            scopeLabel: kind === 'global' ? undefined : scopeLabelOf(bankId),
            mentalModels: selectedModels,
            observations: selectedObservations,
            recalls: filtered,
            maxTokens: kind === 'global' ? 300 : undefined,
        };
    }

    private static observationStaleDays(): number {
        const v = configInt('OBSERVATION_STALE_DAYS', 90);
        return v > 0 ? v : 90;
    }

    static buildObservationSectionForBank(bankId: string): string {
        const obs = getEngine().repository.listObservations(bankId);
        if (!obs.length) return '';
        const now = Math.floor(Date.now() / 1000);
        return obs
            .filter((o: Observation) => o.status === 'active' && now - (o.lastSupportedAt || o.updatedAt) <= this.observationStaleDays() * 86400)
            .slice(0, 20)
            .map((o: Observation, i: number) => `${i + 1}. ${o.text}`)
            .join('\n');
    }

    // ===== 管理/状态 =====

    static async deleteFacts(bankId: string, ids: string[]): Promise<number> {
        const repo = getEngine().repository;
        const before = repo.listUnits(bankId).length;
        repo.deleteUnits(bankId, ids, true);
        if (before !== repo.listUnits(bankId).length) bumpMemoryRevision();
        return before - repo.listUnits(bankId).length;
    }

    static async clearBank(bankId: string, hard = true): Promise<number> {
        const repo = getEngine().repository;
        const units = repo.listUnits(bankId);
        if (hard) {
            repo.deleteUnits(bankId, units.map((u: MemoryUnit) => u.id), true);
            for (const obs of repo.listObservations(bankId)) repo.deleteObservation(bankId, obs.id);
            for (const model of repo.listMentalModels(bankId)) repo.deleteMentalModel(bankId, model.id);
            const bank = repo.getBank(bankId);
            if (bank) {
                bank.meta.settings.seededMentalModelVersion = 0;
                bank.meta.settings.pendingFactCount = 0;
            }
            repo.save(bankId, ['units', 'links', 'obs', 'meta']);
        } else {
            const now = Math.floor(Date.now() / 1000);
            for (const unit of units) {
                unit.state = 'invalidated';
                unit.invalidatedAt = now;
            }
            repo.save(bankId, ['units']);
        }
        bumpMemoryRevision();
        bumpSummaryRevision();
        return units.length;
    }

    static status(bankId: string): MemoryStatus {
        const repo = getEngine().repository;
        const bank = repo.getBank(bankId);
        const units = bank?.units || [];
        const facts = units.filter((u: MemoryUnit) => u.state === 'valid');
        const pending = facts.filter((u: MemoryUnit) => u.consolidationState === 'pending').length;
        const observations = bank?.observations || [];
        const now = Math.floor(Date.now() / 1000);
        const expired = observations.filter((o: Observation) => now - (o.lastSupportedAt || o.updatedAt) > this.observationStaleDays() * 86400).length;
        const models = bank?.mentalModels || [];
        const next = models
            .filter((m: MentalModel) => m.status === 'ready')
            .map((m: MentalModel) => m.lastRefreshedAt || 0)
            .sort((a: number, b: number) => b - a)[0];
        return {
            bankId,
            facts: facts.length,
            invalidated: units.length - facts.length,
            pendingFacts: pending,
            observations: observations.length,
            expiredObservations: expired,
            mentalModels: models.length,
            pendingMentalModels: models.filter((m: MentalModel) => m.status === 'pending').length,
            failedMentalModels: models.filter((m: MentalModel) => m.status === 'failed').length,
            backlog: pending === 0 ? 'up_to_date' : pending < 10 ? 'slightly_stale' : 'stale',
            nextRefreshAt: next ? next + 1800 : undefined,
        };
    }

    static buildBankId(kind: BankKind, id: string): string {
        return `${kind}_${id}`;
    }

    static globalBank(agentName = '*'): string { return this.globalBankId(agentName); }

    static scopeTagsOf(viewer: ViewerContext): string[] {
        const tags: string[] = [];
        if (viewer.userId) tags.push(`user:${viewer.userId}`);
        if (viewer.groupId) tags.push(`group:${viewer.groupId}`);
        tags.push(`global:${globalScopeName(viewer.agentName)}`);
        return tags;
    }
}

function rawSessionId(bankId: string): string {
    return bankId.replace(/^(user|group|global)_/, '');
}

function viewerOf(session: Session, userId?: string, groupId?: string): ViewerContext {
    const isGroup = /-Group:/.test(session.sessionId);
    return {
        sessionId: session.sessionId,
        sessionType: isGroup ? 'group' : 'user',
        userId: userId || (isGroup ? undefined : session.sessionId),
        groupId: groupId || (isGroup ? session.sessionId : undefined),
        agentName: session.agentName,
    };
}

function scopeLabelOf(bankId: string): string {
    const kind = bankKindOf(bankId);
    const raw = rawSessionId(bankId);
    return kind === 'group' ? `群聊：${raw}` : kind === 'user' ? `个人：${raw}` : '';
}

function mergeUnique(models: MentalModel[]): MentalModel[] {
    const out: MentalModel[] = [];
    const seen = new Set<string>();
    for (const m of models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
    }
    return out;
}

function safeJson(text: string): any {
    if (!text) return null;
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); } catch { return null; }
}

function parseOccurredAt(value: unknown): number | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const v = value.trim();
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) return num < 1e12 ? Math.floor(num) : Math.floor(num / 1000);
    const m = v.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
    if (m) return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000);
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}

function containsUserRef(text: string): boolean {
    return /(QQ|qq)[:_-]?\d{3,}/.test(text) || /\b\d{5,12}\b/.test(text);
}

function configBool(key: string, fallback: boolean): boolean {
    const value = (Config.memory as unknown as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : fallback;
}
function configInt(key: string, fallback: number): number {
    const value = (Config.memory as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export { parseOccurredAt, getVisibility, getOriginScope, estimateTokens, normalizeName };


