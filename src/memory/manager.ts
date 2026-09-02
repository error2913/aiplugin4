// 记忆管理器：统一长期/观察/知识库的读取入口，底层只使用 Hindsight-like 新引擎。
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { SUMMARY_PROMPT_TEMPLATE } from "../prompt/templates";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { buildContent } from "../utils/message";
import { stripInternalTags } from "../utils/string";

import { knowledgeService } from "./knowledge";
import { bumpMemoryRevision, bumpSummaryRevision } from "./revision";
import { parseLooseJson } from "./session_memory";
import { resolveBankId } from "./v2/bank_resolver";
import { getMemoryEngine, mentalModelTemplatesFor, personaQuestionFor } from "./v2/index";
import { buildGroupedMemoryPrompt, buildLongTermMemoryPrompt, buildMentalModelsPrompt, MemoryPromptSection, mergeMentalModels, selectInjectionCandidates } from "./v2/prompt";
import type { BankKind, MemoryUnit, MentalModel, RecallOptions, RetainResult } from "./v2/types";

function bankForSession(session: Session) {
    const kind = session.sessionType === 'group' ? 'group' : 'user';
    return resolveBankId(session.sessionId, kind, session.agentName);
}

function tagsForSession(uis: UserInfo[], gi: GroupInfo | null): string[] {
    const tags = uis.map(u => `user:${u.id}`);
    if (gi) tags.push(`group:${gi.id}`);
    return tags;
}

/** 群聊注入时，每个最近发言者个人记忆库的召回 token 预算 */
const MERGE_USER_RECALL_MAX_TOKENS = 1024;
/** 群聊注入时，每个最近发言者最多并入的个人记忆条数 */
const PER_USER_RECALLS = 20;
/** 群聊注入时，每个最近发言者最多并入的个人心智模型条数 */
const PER_USER_MENTAL_MODELS = 2;
/** 群聊注入时，单个最近发言者个人记忆组的字符预算（按分数降序截断，避免多库膨胀） */
const PER_USER_RECALL_MAX_CHARS = 2048;

/** 最近发言者注入人数上限 */
const MAX_RECENT_USERS = 3;
/** 群聊长期记忆注入条数上限 */
const MAX_GROUP_RECALLS = 20;
/** 长期记忆全段总条数上限 */
const MAX_TOTAL_RECALLS = 20;
/** 群聊心智模型注入条数上限 */
const MAX_GROUP_MENTAL_MODELS = 3;
/** 心智模型全段总条数上限 */
const MAX_TOTAL_MENTAL_MODELS = 5;

/** 群聊内某发言者个人段固定注入的内置心智模型条数上限（预留语义召回名额） */
const SPEAKER_FIXED_MENTAL_MODELS = 1;

/**
 * 固定心智模型挑选：按模板目录顺序取 ready 且 scope 命中的内置模型。
 * 用户自定义模型（无 templateId）不在此列，由语义召回竞争剩余名额。
 */
function pickFixedMentalModels(
    kind: BankKind,
    models: MentalModel[],
    sessionTags: string[],
    max?: number
): MentalModel[] {
    const tagSet = new Set(sessionTags);
    const byTemplate = new Map<string, MentalModel>();
    for (const m of models) {
        if (!m.templateId) continue;
        if (m.status !== 'ready' && m.status !== undefined) continue;
        const tags = m.scopeTags || [];
        if (tags.length > 0 && !tags.some(t => tagSet.has(t))) continue;
        if (!byTemplate.has(m.templateId)) byTemplate.set(m.templateId, m);
    }
    const out: MentalModel[] = [];
    for (const tpl of mentalModelTemplatesFor(kind)) {
        const m = byTemplate.get(tpl.id);
        if (m) out.push(m);
        if (max !== undefined && out.length >= max) break;
    }
    return out;
}

export class MemoryManager {
    /**
     * 旧 persona 懒迁移：把仍存于 session.memory.persona 的旧设定写入心智模型
     * （固定模板 persona 问题，按会话类型取专属文案），随后清空 persona。
     * 幂等：bank 已有该问题的模型时只清空 persona，不重复写入。
     */
    static async migrateLegacyPersona(session: Session): Promise<void> {
        const persona = session.memory.persona;
        if (!persona || persona === '无') return;
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        engine.ensureBank(bank.bankId, bank.kind, bank.agentName);
        const scopeTag = session.sessionType === 'group' ? `group:${session.sessionId}` : `user:${session.sessionId}`;
        const personaQuestion = personaQuestionFor(bank.kind);
        const existing = engine.listMentalModels(bank.bankId).find(m => m.question === personaQuestion);
        if (!existing) {
            await engine.createMentalModel(bank.bankId, personaQuestion, stripInternalTags(persona), [scopeTag], { templateId: 'persona' });
            bumpMemoryRevision();
        }
        session.memory.persona = '无';
        session.save();
    }

    /** 长期记忆段：MentalModel + Recall 混合渲染（观察记忆独立注入） */
    static async buildLongTermPrompt(ctx: seal.MsgContext, session: Session, text: string, uis: UserInfo[], gi: GroupInfo | null): Promise<string> {
        const { MEMORY } = Config.memory;
        if (!MEMORY) return '';
        // 旧 persona 懒迁移：首次构建长期提示时把存量 persona 写入心智模型后清空
        await MemoryManager.migrateLegacyPersona(session);
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        engine.ensureBank(bank.bankId, bank.kind, bank.agentName);
        const tags = tagsForSession(uis, gi || null);
        const callerSessionId = ctx.player?.userId || session.sessionId;
        // 固定模板懒补建：有记忆/观察的 bank 才播种（含旧 persona 问题改名迁移）；无模板总开关则跳过
        if (Config.memory.MEMORY_MM_TEMPLATES) {
            const tplScope = session.sessionType === 'group'
                ? `group:${session.sessionId}`
                : `user:${ctx.player?.userId || session.sessionId || ''}`;
            engine.ensureDefaultMentalModels(bank.bankId, session.sessionType === 'group' ? 'group' : 'user', tplScope);
        }
        const groupRecalls = (await engine.recall(bank.bankId, text, {
            tags,
            maxTokens: 2048,
            preferObservations: true,
            budget: 'mid',
        })).filter(r => canSeeMemoryUnit(r.unit, callerSessionId));
        // 群聊不再在此处注入观察记忆；观察记忆由 buildObservationPrompt 独立注入。
        // 心智模型注入：固定模板（写死）优先 + 语义召回（Hindsight 相关度排序）填余量；
        // 查询向量每轮只算一次，复用于群聊/各发言者个人库。
        let qEmbed: number[] | null | undefined;
        const queryEmbedding = async (): Promise<number[] | null> => {
            if (qEmbed === undefined) qEmbed = await engine.embedQuery(text);
            return qEmbed;
        };
        const templatesEnabled = Config.memory.MEMORY_MM_TEMPLATES;
        const allBankMMs = engine.listMentalModels(bank.bankId);
        const fixedMMs = templatesEnabled ? pickFixedMentalModels(bank.kind, allBankMMs, tags) : [];
        const bankMMCap = session.sessionType === 'group' ? MAX_GROUP_MENTAL_MODELS : MAX_TOTAL_MENTAL_MODELS;
        const bankSemanticLimit = Math.max(0, bankMMCap - fixedMMs.length);
        const bankRanked = bankSemanticLimit > 0 && allBankMMs.length > fixedMMs.length
            ? await engine.searchMentalModels(bank.bankId, text, {
                tags,
                limit: bankSemanticLimit,
                queryEmbedding: await queryEmbedding(),
                excludeTemplates: templatesEnabled,
            })
            : [];
        const groupMMs = mergeMentalModels(fixedMMs, bankRanked, bankMMCap);

        // 分组渲染：群聊按「群聊 / 每个最近发言者」分别渲染长期记忆 + 心智模型，避免归属混淆；
        // 个人记忆按用户标签召回、单用户条数/字符预算截断，私有记忆仅创建者本人可见（canSeeMemoryUnit）。
        const sections: MemoryPromptSection[] = [];
        const isGroup = session.sessionType === 'group';
        if (isGroup) {
            const groupRecallList = groupRecalls.slice(0, MAX_GROUP_RECALLS);
            const groupId = gi?.id || session.sessionId;
            const groupName = gi?.name || '';
            sections.push({
                title: `群聊记忆（${gi?.name || session.sessionId}）`,
                scopeLabel: groupName ? `群聊：${groupId}（${groupName}）` : `群聊：${groupId}`,
                mentalModels: groupMMs,
                recalls: groupRecallList,
            });

            let mmBudget = MAX_TOTAL_MENTAL_MODELS - groupMMs.length;
            const recentUsers = uis.slice(0, MAX_RECENT_USERS);

            for (const u of recentUsers) {
                const userBankId = resolveBankId(u.id, 'user', session.agentName).bankId;
                // 固定模板懒补建：该发言者个人库有记忆时补建（设定/偏好），供个人分组固定注入
                if (templatesEnabled) {
                    engine.ensureDefaultMentalModels(userBankId, 'user', `user:${u.id}`);
                }
                const ranked = (await engine.recall(userBankId, text, {
                    tags: [`user:${u.id}`],
                    maxTokens: MERGE_USER_RECALL_MAX_TOKENS,
                    preferObservations: true,
                    budget: 'low',
                })).filter(r => canSeeMemoryUnit(r.unit, callerSessionId));
                const userRecalls: typeof groupRecalls = [];
                let total = 0;
                for (const r of ranked) {
                    if (userRecalls.length >= PER_USER_RECALLS) break;
                    if (total + r.unit.text.length > PER_USER_RECALL_MAX_CHARS) break;
                    userRecalls.push(r);
                    total += r.unit.text.length;
                }
                const userAllMMs = engine.listMentalModels(userBankId);
                const userFixed = templatesEnabled
                    ? pickFixedMentalModels('user', userAllMMs, [`user:${u.id}`], SPEAKER_FIXED_MENTAL_MODELS)
                    : [];
                const userTotal = Math.min(PER_USER_MENTAL_MODELS, Math.max(0, mmBudget));
                const usedFixed = Math.min(userFixed.length, userTotal);
                const userRanked = usedFixed < userTotal && userAllMMs.length > userFixed.length
                    ? await engine.searchMentalModels(userBankId, text, {
                        tags: [`user:${u.id}`],
                        limit: userTotal - usedFixed,
                        queryEmbedding: await queryEmbedding(),
                        excludeTemplates: templatesEnabled,
                    })
                    : [];
                const userMMs = mergeMentalModels(userFixed.slice(0, usedFixed), userRanked, userTotal);
                const userName = u.name && u.name !== u.id ? u.name : '';
                sections.push({
                    title: `个人记忆（${u.name || u.id}）`,
                    scopeLabel: userName ? `个人：${u.id}（${userName}）` : `个人：${u.id}`,
                    mentalModels: userMMs,
                    recalls: userRecalls,
                });
                mmBudget -= userMMs.length;
            }
        } else {
            const sessionName = ctx.player?.name || session.sessionId || '';
            const privateRecalls = groupRecalls.slice(0, MAX_TOTAL_RECALLS);
            const privateMMs = groupMMs.slice(0, MAX_TOTAL_MENTAL_MODELS);
            return [buildMentalModelsPrompt(privateMMs), buildLongTermMemoryPrompt(privateRecalls, true, sessionName)].filter(Boolean).join('\n\n');
        }
        Logger.debug(`[记忆注入] bank=${bank.bankId} tags=[${tags.join(',')}] 分组 ${sections.length} 段（群聊 ${isGroup ? uis.length + 1 : 1} 段）`);
        return buildGroupedMemoryPrompt(sections);
    }

    /** 观察记忆段：由 Observation 替代旧 summaries */
    static buildObservationPrompt(session: Session): string {
        const { SUMMARY } = Config.memory;
        if (!SUMMARY) return '';
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        const observations = engine.repository.listObservations(bank.bankId);
        if (observations.length === 0) return '';
        // 与长期记忆段的观察注入同口径：scope 过滤 + stale 剔除 + 条数上限（按会话自身标签宽松匹配）
        const sessionTag = session.sessionType === 'group' ? `group:${session.sessionId}` : `user:${session.sessionId}`;
        const { observations: injectable } = selectInjectionCandidates([], observations, [sessionTag]);
        if (injectable.length === 0) return '';
        return '## 观察记忆\n' + injectable.map((o, i) => `${i + 1}. ${o.text}`).join('\n');
    }

    /** 知识库段：按开关构建，按当前对话文本检索式注入（配置驱动，全局单例加载） */
    static async buildKnowledgePrompt(_session: Session, text: string): Promise<string> {
        const { KNOWLEDGE } = Config.knowledgeBase;
        if (!KNOWLEDGE) return '';
        await knowledgeService.init();
        return knowledgeService.buildKnowledgePrompt(text);
    }

    /** 写入记忆：统一入口，返回新引擎结果 */
    static async retainMemory(
        _ctx: seal.MsgContext | null,
        session: Session,
        uiList: UserInfo[],
        giList: GroupInfo[],
        keywords: string[],
        _images: Image[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: string,
        importance?: number
    ): Promise<RetainResult> {
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        engine.ensureBank(bank.bankId, bank.kind, bank.agentName);
        const tags = [
            ...tagsForSession(uiList, giList.length ? { isPrivate: false, id: giList[0].id, name: giList[0].name } : null),
            ...keywords,
            visibility === 'private' ? `vis:private:${session.sessionId}` : 'vis:public',
        ];
        const result = await engine.addMemory(bank.bankId, {
            content: text,
            tags,
            metadata: {
                type: type || 'text',
                importance: String(importance ?? 0.5),
            },
            importance,
            factType: type === 'event' ? 'experience' : 'world',
            verbatim: true,
        });
        bumpMemoryRevision();
        return result;
    }

    /** 检索记忆：直接返回新引擎单元 */
    static async recallMemory(session: Session, text: string, options: Partial<RecallOptions> = {}): Promise<MemoryUnit[]> {
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        const callerSessionId = session.sessionId;
        const results = await engine.recall(bank.bankId, text, {
            tags: options.tags,
            maxTokens: options.maxTokens || 2048,
            budget: options.budget || 'mid',
            types: ['world', 'experience', 'observation'],
        });
        return results
            .filter(r => canSeeMemoryUnit(r.unit, callerSessionId))
            .map(r => r.unit);
    }

    /** 触发巩固 */
    static async consolidateMemory(session: Session) {
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        const result = await engine.consolidate(bank.bankId);
        bumpSummaryRevision();
        // R2：巩固后自动刷新心智模型（引擎层防重入 + 最小间隔限流）
        if (Config.memory.MEMORY_REFRESH_AFTER_CONSOLIDATE) {
            const summary = await engine.refreshMentalModels(bank.bankId, undefined, { reason: 'consolidate' });
            // 自动刷新实际更新（含 failed→ready 恢复）后失效长期记忆 prompt 缓存
            if (summary.updated > 0) bumpMemoryRevision();
        }
        return result;
    }

    /** 基于记忆推理 */
    static async reflectMemory(session: Session, query: string) {
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        return engine.reflect(bank.bankId, query);
    }

    /**
     * 归档单块消息：将一段即将从 Context 删除的消息交给 summarize_agent 抽取 facts，
     * 写入长期记忆并尝试 consolidate 为观察记忆。成功返回 true，失败返回 false。
     */
    static async summarizeChunk(session: Session, messages: any[]): Promise<boolean> {
        if (!messages || messages.length === 0) return true;
        const roleSetting = (Config.role.ROLE_SETTINGS || [])[0] || '';
        const isPrivate = session.sessionType !== 'group';
        const sessionId = session.sessionId;
        const userNumber = isPrivate ? sessionId.replace(/^.+:/, '') : '';
        const groupNumber = isPrivate ? '' : sessionId.replace(/^.+:/, '');
        const userName = isPrivate ? (User.get(sessionId).userName || userNumber) : '';
        const groupName = isPrivate ? '' : (Group.get(sessionId).groupName || groupNumber);

        const prompt = SUMMARY_PROMPT_TEMPLATE({
            "角色设定": roleSetting,
            "平台": '',
            "私聊": isPrivate,
            "用户名称": userName,
            "用户号码": userNumber,
            "群聊名称": groupName,
            "群聊号码": groupNumber,
            "对话内容": messages.map((message: any) => {
                const toolCalls = (message as any).toolCalls || (message as any).tool_calls;
                if (message.role === 'assistant' && toolCalls && toolCalls.length > 0) {
                    return `\n[function_call]: ${toolCalls.map((tool_call: any, index: number) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
                }
                return `[${message.role}]: ${buildContent(message as any)}`;
            }).join('\n')
        });

        try {
            const reply = await Agent.get('summarize_agent').chat(prompt);
            if (!reply) return false;
            const memoryData = parseLooseJson(reply);
            if (!memoryData || typeof memoryData !== 'object') return false;
            const facts = Array.isArray(memoryData.facts) ? memoryData.facts : [];

            const engine = getMemoryEngine();
            const bank = bankForSession(session);
            engine.ensureBank(bank.bankId, bank.kind, bank.agentName);
            const baseTags = [
                ...(isPrivate ? [`user:${sessionId}`] : [`group:${sessionId}`]),
                'vis:public',
            ];

            for (const fact of facts as any[]) {
                if (!fact || typeof fact.text !== 'string' || !fact.text.trim()) continue;
                if (fact.op === 'delete') continue;
                const occurredStart = parseOccurredAt(fact.occurred_at);
                await engine.addMemory(bank.bankId, {
                    content: fact.text.trim(),
                    tags: Array.from(new Set([...baseTags, ...(Array.isArray(fact.keywords) ? fact.keywords : [])])),
                    metadata: { type: fact.type || 'fact' },
                    importance: typeof fact.importance === 'number' ? fact.importance : 0.5,
                    factType: fact.type === 'event' ? 'experience' : 'world',
                    entities: Array.isArray(fact.entities) ? fact.entities.map(String) : undefined,
                    occurredStart,
                    verbatim: !Config.memory.MEMORY_LLM_EXTRACT,
                });
            }

            bumpMemoryRevision();
            try {
                await engine.consolidate(bank.bankId);
                bumpSummaryRevision();
            } catch (e) {
                Logger.warning('归档后 consolidate 失败（不影响 facts 已写入）: ' + (e instanceof Error ? e.message : String(e)));
            }
            return true;
        } catch (e) {
            Logger.warning('归档总结失败: ' + (e instanceof Error ? e.message : String(e)));
            return false;
        }
    }

    /** 单块归档最多尝试 MAX_ARCHIVE_ATTEMPTS 次，全部失败返回 false */
    static async summarizeChunkWithRetry(session: Session, messages: any[]): Promise<boolean> {
        const MAX_ARCHIVE_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ARCHIVE_ATTEMPTS; attempt++) {
            const ok = await MemoryManager.summarizeChunk(session, messages);
            if (ok) return true;
            Logger.warning(`归档总结第 ${attempt} 次失败，准备重试`);
        }
        return false;
    }
}

/** 解析 LLM 抽取的事件时间：支持 ISO 8601、'YYYY年M月D日'/'YYYY-MM-DD' 与秒级/毫秒级时间戳；解析失败返回 undefined */
export function parseOccurredAt(value: unknown): number | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const v = value.trim();
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) return num < 1e12 ? Math.floor(num) : Math.floor(num / 1000);
    const m = v.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
    if (m) return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000);
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
    return undefined;
}

function canSeeMemoryUnit(unit: MemoryUnit, callerSessionId: string): boolean {
    const privateTags = unit.tags.filter(t => t.startsWith('vis:private:'));
    if (privateTags.length === 0) return true;
    return privateTags.some(t => t === `vis:private:${callerSessionId}`);
}
