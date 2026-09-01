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
import { getMemoryEngine, MENTAL_MODEL_PERSONA_QUESTION } from "./v2/index";
import { buildGroupedMemoryPrompt, buildLongTermMemoryPrompt, buildMentalModelsPrompt, MemoryPromptSection, selectInjectionCandidates } from "./v2/prompt";
import type { MemoryUnit, RecallOptions, RetainResult } from "./v2/types";

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

export class MemoryManager {
    /**
     * 旧 persona 懒迁移：把仍存于 session.memory.persona 的旧设定写入心智模型
     * （固定问题 MENTAL_MODEL_PERSONA_QUESTION），随后清空 persona。
     * 幂等：bank 已有该问题的模型时只清空 persona，不重复写入。
     */
    static async migrateLegacyPersona(session: Session): Promise<void> {
        const persona = session.memory.persona;
        if (!persona || persona === '无') return;
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        engine.ensureBank(bank.bankId, bank.kind, bank.agentName);
        const scopeTag = session.sessionType === 'group' ? `group:${session.sessionId}` : `user:${session.sessionId}`;
        const existing = engine.listMentalModels(bank.bankId).find(m => m.question === MENTAL_MODEL_PERSONA_QUESTION);
        if (!existing) {
            await engine.createMentalModel(bank.bankId, MENTAL_MODEL_PERSONA_QUESTION, stripInternalTags(persona), [scopeTag]);
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
        const groupRecalls = (await engine.recall(bank.bankId, text, {
            tags,
            maxTokens: 2048,
            preferObservations: true,
            budget: 'mid',
        })).filter(r => canSeeMemoryUnit(r.unit, callerSessionId));
        // 群聊不再在此处注入观察记忆；观察记忆由 buildObservationPrompt 独立注入
        // 群心智模型：Hindsight 心智模型语义召回式注入（相关度排序 + scope 过滤 + 条数上限）；
        // 查询向量每轮只算一次，复用于群聊/各发言者个人库
        let qEmbed: number[] | null | undefined;
        const queryEmbedding = async (): Promise<number[] | null> => {
            if (qEmbed === undefined) qEmbed = await engine.embedQuery(text);
            return qEmbed;
        };
        const groupMMs = engine.listMentalModels(bank.bankId).length > 0
            ? await engine.searchMentalModels(bank.bankId, text, {
                tags,
                limit: MAX_GROUP_MENTAL_MODELS,
                queryEmbedding: await queryEmbedding(),
            })
            : [];

        // 分组渲染：群聊按「群聊 / 每个最近发言者」分别渲染长期记忆 + 心智模型，避免归属混淆；
        // 个人记忆按用户标签召回、单用户条数/字符预算截断，私有记忆仅创建者本人可见（canSeeMemoryUnit）。
        const sections: MemoryPromptSection[] = [];
        const isGroup = session.sessionType === 'group';
        if (isGroup) {
            const groupRecallList = groupRecalls.slice(0, MAX_GROUP_RECALLS);
            sections.push({
                title: `群聊记忆（${gi?.name || session.sessionId}）`,
                mentalModels: groupMMs,
                recalls: groupRecallList,
            });

            let mmBudget = MAX_TOTAL_MENTAL_MODELS - groupMMs.length;
            const recentUsers = uis.slice(0, MAX_RECENT_USERS);

            for (const u of recentUsers) {
                const userBankId = resolveBankId(u.id, 'user', session.agentName).bankId;
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
                const userMMs = engine.listMentalModels(userBankId).length > 0
                    ? await engine.searchMentalModels(userBankId, text, {
                        tags: [`user:${u.id}`],
                        limit: Math.min(PER_USER_MENTAL_MODELS, mmBudget),
                        queryEmbedding: await queryEmbedding(),
                    })
                    : [];
                sections.push({ title: `个人记忆（${u.name || u.id}）`, mentalModels: userMMs, recalls: userRecalls });
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
            await engine.refreshMentalModels(bank.bankId, undefined, { reason: 'consolidate' });
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
     * 对话记忆抽取：参考 Hindsight Retain，复用 summarize_agent 从最近对话抽取 facts，
     * 写入新引擎后触发 Observation 巩固。
     */
    static async retainConversation(session: Session): Promise<void> {
        // Hindsight cron 等价物：定时刷新心智模型（仅当 scope 内有新记忆时实际刷新，staleness gating 保证不烧 token）
        const tickIntervalMin = Config.memory.MEMORY_MM_TICK_INTERVAL;
        if (tickIntervalMin > 0) {
            const tickEngine = getMemoryEngine();
            const tickBank = bankForSession(session);
            const last = tickEngine.getLastAutoRefreshAt(tickBank.bankId);
            if (last <= 0 || Date.now() / 1000 - last >= tickIntervalMin * 60) {
                await tickEngine.refreshMentalModels(tickBank.bankId, undefined, { reason: 'tick' });
            }
        }
        const { SUMMARY, SUMMARY_SIZE } = Config.memory;
        if (session.memory.summaryOverride === false) return;
        if (session.memory.summaryOverride !== true && !SUMMARY) return;
        const messages = session.context.messages;
        let start = session.context.lastSummarizedIndex || 0;
        if (start > messages.length) start = 0;
        let end = messages.length;
        let round = 0;
        for (let i = start; i < messages.length; i++) {
            if ((messages[i] as any).role === 'user') round++;
            if (round > SUMMARY_SIZE) {
                end = i;
                break;
            }
        }
        const sumMessages = messages.slice(start, end);
        if (sumMessages.length === 0) return;

        const roleSetting = (Config.message.ROLE_SETTINGS || [])[0] || '';
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
            "对话内容": sumMessages.map(message => {
                const toolCalls = (message as any).toolCalls || (message as any).tool_calls;
                if (message.role === 'assistant' && toolCalls && toolCalls.length > 0) {
                    return `\n[function_call]: ${toolCalls.map((tool_call: any, index: number) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
                }
                return `[${message.role}]: ${buildContent(message as any)}`;
            }).join('\n')
        });

        const reply = await Agent.get('summarize_agent').chat(prompt);
        if (!reply) return;
        const memoryData = parseLooseJson(reply);
        if (!memoryData || typeof memoryData !== 'object') return;
        const facts = Array.isArray(memoryData.facts)
            ? memoryData.facts as Array<{ text?: string; keywords?: string[]; importance?: number; type?: string; visibility?: string; related_user_ids?: string[]; related_group_ids?: string[]; memory_type?: string; target_id?: string; op?: string; existing_id?: string; occurred_at?: string; entities?: string[] }>
            : [];

        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        engine.ensureBank(bank.bankId, bank.kind, bank.agentName);
        const baseTags = [
            ...(isPrivate ? [`user:${sessionId}`] : [`group:${sessionId}`]),
            'vis:public',
        ];
        for (const fact of facts) {
            if (!fact || typeof fact.text !== 'string' || !fact.text.trim()) continue;
            if (fact.op === 'delete') continue;
            // E3：结构化抽取——事件时间与实体随事实入库，供时间检索/实体关联使用
            const occurredStart = parseOccurredAt(fact.occurred_at);
            await engine.addMemory(bank.bankId, {
                content: fact.text.trim(),
                tags: Array.from(new Set([...baseTags, ...(fact.keywords || [])])),
                metadata: { type: fact.type || 'fact' },
                importance: typeof fact.importance === 'number' ? fact.importance : 0.5,
                factType: fact.type === 'event' ? 'experience' : 'world',
                entities: Array.isArray(fact.entities) ? fact.entities.map(String) : undefined,
                occurredStart,
                verbatim: !Config.memory.MEMORY_LLM_EXTRACT,
            });
        }

        bumpMemoryRevision();
        session.context.lastSummarizedIndex = end;
        // 巩固间隔：每累计 CONSOLIDATE_INTERVAL 次观察整合一次重复观察；0 为关闭（consolidate_memory 工具 / .ai memo 手动巩固不受影响）
        const consolidateInterval = Config.memory.CONSOLIDATE_INTERVAL;
        if (consolidateInterval > 0) {
            const since = engine.getConsolidateSince(bank.bankId) + 1;
            if (since >= consolidateInterval) {
                await engine.consolidate(bank.bankId);
                bumpSummaryRevision();
                engine.setConsolidateSince(bank.bankId, 0);
                // R2：巩固后自动刷新心智模型（引擎层防重入 + 最小间隔限流）
                if (Config.memory.MEMORY_REFRESH_AFTER_CONSOLIDATE) {
                    await engine.refreshMentalModels(bank.bankId, undefined, { reason: 'consolidate' });
                }
            } else {
                engine.setConsolidateSince(bank.bankId, since);
            }
        }
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
