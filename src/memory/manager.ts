// 记忆管理器：统一长期/观察/知识库的读取入口，底层只使用 Hindsight-like 新引擎。
import Agent from "../agent/agent";
import Config from "../config/config";
import { SUMMARY_PROMPT_TEMPLATE } from "../prompt/templates";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { buildContent } from "../utils/message";
import { stripInternalTags } from "../utils/string";

import { knowledgeService } from "./knowledge";
import { bumpMemoryRevision } from "./revision";
import { parseLooseJson } from "./session_memory";
import { resolveBankId } from "./v2/bank_resolver";
import { getMemoryEngine, MENTAL_MODEL_PERSONA_QUESTION } from "./v2/index";
import { buildMemoryPrompt, selectInjectionCandidates } from "./v2/prompt";
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

    /** 长期记忆段：MentalModel + Observation + Recall 混合渲染 */
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
        const recalls = (await engine.recall(bank.bankId, text, {
            tags,
            maxTokens: 2048,
            preferObservations: true,
            budget: 'mid',
        })).filter(r => canSeeMemoryUnit(r.unit, callerSessionId));
        const allObservations = engine.repository.listObservations(bank.bankId);
        const allMentalModels = engine.listMentalModels(bank.bankId);
        // E1/E2：scopeTags 过滤 + stale 剔除 + 条数上限（注入裁剪，控制 token）
        const { mentalModels, observations } = selectInjectionCandidates(allMentalModels, allObservations, tags);
        const sessionName = ctx.isPrivate ? (ctx.player?.name || '') : (ctx.group?.groupName || '');
        return buildMemoryPrompt({
            isPrivate: ctx.isPrivate,
            sessionName,
            mentalModels,
            observations,
            recalls,
        });
    }

    /** 观察记忆段：由 Observation 替代旧 summaries */
    static buildObservationPrompt(session: Session): string {
        const { SUMMARY } = Config.memory;
        if (!SUMMARY) return '';
        const engine = getMemoryEngine();
        const bank = bankForSession(session);
        const observations = engine.repository.listObservations(bank.bankId);
        if (observations.length === 0) return '';
        return '## 观察记忆\n' + observations.map((o, i) => `${i + 1}. ${o.text}`).join('\n');
    }

    /** 知识库段：按开关构建（配置驱动，全局单例加载） */
    static async buildKnowledgePrompt(_session: Session, _text: string): Promise<string> {
        const { KNOWLEDGE } = Config.knowledgeBase;
        if (!KNOWLEDGE) return '';
        await knowledgeService.init();
        return knowledgeService.buildKnowledgePrompt();
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
        // R2：巩固后自动刷新心智模型（引擎层防重入 + 最小间隔限流）
        if (Config.memory.MEMORY_REFRESH_AFTER_CONSOLIDATE) {
            await engine.refreshMentalModels(bank.bankId);
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
                engine.setConsolidateSince(bank.bankId, 0);
                // R2：巩固后自动刷新心智模型（引擎层防重入 + 最小间隔限流）
                if (Config.memory.MEMORY_REFRESH_AFTER_CONSOLIDATE) {
                    await engine.refreshMentalModels(bank.bankId);
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
