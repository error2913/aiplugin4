// v2 → v3 惰性迁移（幂等）：观察单元去除、字段改名、可见性重分类、心智模型结构化。
import { parseMarkdown } from "./structured";
import { isLegacyPersonaQuestion, personaQuestionFor } from "./templates";
import type { MemoryBankMeta, MemoryUnit, MentalModel, Observation, PersistedBank } from "./types";

function withSafeVisibility(tags: string[], kind: 'user' | 'group' | 'global'): string[] {
    const clean = tags.filter(t => !/^vis:/.test(t));
    if (kind === 'user') return [...clean, 'vis:owner'];
    return tags.some(t => /^vis:/.test(t)) ? tags : [...clean, 'vis:public'];
}

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bankKindOfId(bankId: string): 'user' | 'group' | 'global' {
    const prefix = String(bankId || '').split('_')[0];
    return prefix === 'user' || prefix === 'group' || prefix === 'global' ? prefix : 'global';
}

function migrateVisibility(tags: string[], kind: 'user' | 'group' | 'global'): string[] {
    // user bank：旧数据没有可靠来源信息，统一收紧为 owner（仅本人 DM），避免群注入泄露；
    // group bank：旧 private 收紧为 public? 不，private 仅来源群可见 → origin；public 保持；global：public。
    if (kind === 'user') return ['vis:owner'];
    if (kind === 'global') return ['vis:public'];
    const out = new Set<string>();
    for (const tag of tags || []) {
        if (tag === 'vis:private' || tag.startsWith('vis:private:')) out.add('vis:public');
        else if (tag === 'vis:public') out.add('vis:public');
        else if (tag.startsWith('vis:origin')) out.add(tag);
    }
    if (out.size === 0) out.add('vis:public');
    return Array.from(out);
}

export interface MigrateResult {
    changed: boolean;
    bank: PersistedBank;
}

export function migrateBankV3(input: PersistedBank): MigrateResult {
    let changed = false;
    const bank: PersistedBank = {
        meta: input.meta,
        units: input.units || [],
        entities: input.entities || [],
        links: input.links || [],
        observations: input.observations || [],
        mentalModels: input.mentalModels || [],
    };
    const kind = bankKindOfId(bank.meta?.id || '');
    const oldSchema = (bank.meta as unknown as { schemaVersion?: number })?.schemaVersion;
    if (oldSchema !== 3) changed = true;

    const meta: MemoryBankMeta = {
        id: bank.meta.id,
        kind: (bank.meta as unknown as { kind?: string }).kind === 'user' || (bank.meta as unknown as { kind?: string }).kind === 'group'
            ? (bank.meta as unknown as { kind: 'user' | 'group' }).kind
            : kind,
        agentName: bank.meta.agentName,
        sessionId: bank.meta.sessionId,
        createdAt: num(bank.meta.createdAt, Math.floor(Date.now() / 1000)),
        updatedAt: num(bank.meta.updatedAt, Math.floor(Date.now() / 1000)),
        schemaVersion: 3,
        settings: {
            seededMentalModelVersion: (bank.meta.settings as unknown as { seededMentalModelVersion?: number })?.seededMentalModelVersion,
            nextFactSeq: (bank.meta.settings as unknown as { nextFactSeq?: number })?.nextFactSeq,
            pendingFactCount: (bank.meta.settings as unknown as { pendingFactCount?: number })?.pendingFactCount,
            lastExtractAt: (bank.meta.settings as unknown as { lastExtractAt?: number })?.lastExtractAt,
            lastConsolidateAt: (bank.meta.settings as unknown as { lastConsolidateAt?: number })?.lastConsolidateAt,
            lastAutoRefreshAt: (bank.meta.settings as unknown as { lastAutoRefreshAt?: number })?.lastAutoRefreshAt,
        },
    };
    // sessionId 旧实现可能写成 bankId：还原为原始会话 ID
    if (meta.sessionId && meta.sessionId === meta.id) meta.sessionId = meta.id.replace(/^(user|group|global)_/, '');

    const observationUnits = bank.units.filter((u: any) => u.factType === 'observation');
    if (observationUnits.length > 0) {
        changed = true;
        // 观察表缺失时用同步 unit 兜底重建
        for (const unit of observationUnits as any[]) {
            if (!bank.observations.some(o => o.id === unit.id)) {
                const obs: Observation = {
                    id: unit.id,
                    bankId: bank.meta.id,
                    text: String(unit.text || ''),
                    tags: withSafeVisibility((unit.tags || []).filter((t: string) => /^(user|group|global):/.test(t)), kind),
                    evidence: [],
                    proofCount: 0,
                    createdAt: num(unit.createdAt),
                    updatedAt: num(unit.updatedAt || unit.createdAt),
                    lastSupportedAt: num(unit.updatedAt || unit.createdAt),
                    status: 'active',
                    history: [{ text: String(unit.text || ''), reason: 'created', at: num(unit.createdAt) }],
                };
                bank.observations.push(obs);
            }
        }
    }

    let seq = 0;
    const units: MemoryUnit[] = bank.units
        .filter((u: any) => u.factType !== 'observation')
        .sort((a: any, b: any) => num(a.createdAt) - num(b.createdAt))
        .map((u: any) => {
            seq++;
            const tags = migrateVisibility(Array.isArray(u.tags) ? u.tags : [], kind);
            return {
                id: String(u.id),
                bankId: bank.meta.id,
                text: String(u.text || ''),
                factType: u.factType === 'experience' ? 'experience' : 'world',
                occurredStart: u.occurredStart,
                occurredEnd: u.occurredEnd,
                mentionedAt: u.mentionedAt,
                createdAt: num(u.createdAt),
                createdAtSeq: num(u.createdAtSeq, seq),
                updatedAt: num(u.updatedAt || u.createdAt),
                embedding: Array.isArray(u.embedding) ? u.embedding : [],
                entityIds: Array.isArray(u.entityIds) ? u.entityIds : [],
                tags,
                metadata: u.metadata && typeof u.metadata === 'object' ? u.metadata : {},
                importance: num(u.importance, 0.5),
                accessCount: num(u.accessCount, 0),
                lastAccessedAt: num(u.lastAccessedAt),
                state: u.state === 'invalidated' ? 'invalidated' : 'valid',
                invalidatedAt: u.invalidatedAt,
                invalidatedBy: u.invalidatedBy,
                supersedes: u.supersedes,
                consolidationState: u.consolidationState === 'pending' ? 'pending' : 'done',
                consolidatedAt: u.consolidatedAt,
            };
        });
    seq = Math.max(seq, num(meta.settings.nextFactSeq));
    meta.settings.nextFactSeq = seq;

    const observations = bank.observations.map((o: any) => {
        const updatedAt = num(o.updatedAt || o.createdAt);
        return {
            id: String(o.id),
            bankId: bank.meta.id,
            text: String(o.text || ''),
            tags: withSafeVisibility(Array.isArray(o.tags) ? o.tags : (Array.isArray(o.scopeTags) ? o.scopeTags : []), kind),
            evidence: Array.isArray(o.evidence)
                ? o.evidence.map((e: any) => ({ memoryId: String(e.memoryId), quote: String(e.quote || ''), addedAt: num(e.addedAt, updatedAt) }))
                : [],
            proofCount: num(o.proofCount, Array.isArray(o.evidence) ? o.evidence.length : 0),
            createdAt: num(o.createdAt),
            updatedAt,
            lastSupportedAt: num(o.lastSupportedAt, num(o.lastVerifiedAt, updatedAt)),
            status: o.status === 'invalidated' ? 'invalidated' : 'active',
            history: Array.isArray(o.history)
                ? o.history.map((h: any) => ({ text: String(h.text || ''), reason: h.reason || 'created', at: num(h.at, updatedAt) }))
                : [],
        } as Observation;
    });
    if (JSON.stringify(observations) !== JSON.stringify(bank.observations)) changed = true;

    const mentalModels = bank.mentalModels.map((m: any) => {
        const content = String(m.content ?? m.answer ?? '');
        const rawQuestion = String(m.sourceQuery ?? m.question ?? '');
        const legacyPersona = isLegacyPersonaQuestion(rawQuestion);
        const sourceQuery = legacyPersona ? personaQuestionFor(kind) : rawQuestion;
        const tags = Array.isArray(m.tags) ? m.tags : (Array.isArray(m.scopeTags) ? m.scopeTags : []);
        const trigger = m.trigger && typeof m.trigger === 'object'
            ? m.trigger
            : (m.triggerConfig && typeof m.triggerConfig === 'object' ? m.triggerConfig : {});
        const answer = content;
        const model: MentalModel = {
            id: String(m.id),
            bankId: bank.meta.id,
            sourceQuery,
            content,
            structuredContent: m.structuredContent && m.structuredContent.version === 1
                ? m.structuredContent
                : parseMarkdown(content),
            trigger: {
                mode: trigger.mode === 'delta' ? 'delta' : 'full',
                refreshAfterConsolidation: false,
                factTypes: Array.isArray(trigger.factTypes) && trigger.factTypes.length
                    ? trigger.factTypes
                    : ['world', 'experience'],
                tagsMatch: tags.length ? 'all_strict' : 'any',
            },
            tags,
            maxTokens: 2048,
            status: answer.trim() ? 'ready' : 'pending',
            createdAt: num(m.createdAt),
            updatedAt: num(m.updatedAt || m.createdAt),
            lastRefreshedAt: num(m.lastRefreshedAt),
            lastFullRefreshAt: num(m.lastFullRefreshAt, num(m.lastRefreshedAt)),
            lastRefreshedSourceQuery: String(m.lastRefreshedSourceQuery ?? sourceQuery),
            lastMemorySeenSeq: 0,
            reflectResponse: m.reflectResponse,
            history: Array.isArray(m.history)
                ? m.history.map((h: any) => ({
                    content: String(h.content ?? h.answer ?? ''),
                    at: num(h.at),
                    trigger: h.trigger || 'manual',
                }))
                : [],
            embedding: Array.isArray(m.embedding) ? m.embedding : [],
            templateId: m.templateId || (legacyPersona ? 'persona' : undefined),
        };
        return model;
    });
    if (JSON.stringify(mentalModels) !== JSON.stringify(bank.mentalModels)) changed = true;

    const links = bank.links.filter((l: any) => l.linkType === 'entity' || l.linkType === 'semantic' || l.linkType === 'related');
    if (links.length !== bank.links.length) changed = true;
    meta.settings.pendingFactCount = units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;

    return {
        changed,
        bank: {
            meta,
            units,
            entities: bank.entities,
            links,
            observations,
            mentalModels,
        },
    };
}


