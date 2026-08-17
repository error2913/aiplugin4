// 会话记忆：短期记忆总结（调用摘要智能体）与记忆 prompt 构建
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { SUMMARY_PROMPT_TEMPLATE, SUMMARY_TEMPLATE } from "../prompt/templates";
import Group from "../session/group";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { buildContent } from "../utils/message";
import { stripInternalTags } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";

import MemoryService from "./memory";
import MemoryItem from "./memory_item";
import { bumpSummaryRevision } from "./revision";

export default class SessionMemoryService extends MemoryService {
    static validKeysMap: { [key in keyof SessionMemoryService]?: TypeDescriptor<SessionMemoryService[key]> } = {
        memoryMap: { array: MemoryItem },
        agentName: 'string',
        sessionId: 'string',
        summaryStatus: 'boolean',
        summaries: { array: 'string' },
        useShortMemory: 'boolean',
        shortMemoryList: { array: 'string' },
        persona: 'string'
    };
    agentName: string;
    sessionId: string;
    summaryStatus: boolean;
    summaries: string[];

    constructor() {
        super();
        this.agentName = '';
        this.sessionId = '';
        this.summaryStatus = false;
        this.summaries = [];
    }

    get agent(): Agent { return Agent.get(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }

    // 短期记忆总结（每轮对话后由 context.addAssistantMessage 触发）
    async summarize() {
        // 开关：.ai memo short on/off 控制 useShortMemory；summaryStatus 兼容旧存档
        if (!this.useShortMemory && !this.summaryStatus) return;

        const { SUMMARY_SIZE } = Config.memory;
        const messages = this.session.context.messages;
        let sumMessages = messages.slice();
        let round = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user') round++;
            if (round > SUMMARY_SIZE) {
                sumMessages = messages.slice(0, i);
                break;
            }
        }
        if (sumMessages.length === 0) return;

        try {
            const roleSetting = (Config.message.ROLE_SETTINGS || [])[0] || '';
            const isPrivate = this.session.sessionType !== 'group';
            const sessionId = this.session.sessionId;
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

            Logger.info('记忆总结prompt:\n', prompt);

            // 使用摘要智能体进行总结（按其 use 选择模型）
            const reply = await Agent.get('summarize_agent').chat(prompt);
            if (!reply) return;

            const memoryData = JSON.parse(reply) as {
                content: string,
                memories: {
                    memory_type: 'private' | 'group',
                    name: string,
                    text: string,
                    keywords?: string[],
                    userList?: string[],
                    groupList?: string[],
                    visibility?: 'public' | 'private',
                }[]
            };

            // 防注入：总结内容可能夹带内部上下文标签，入库前统一剥离；模型未返回 content 时以空串兜底
            const summaryContent = stripInternalTags(memoryData.content || '');
            this.shortMemoryList.push(summaryContent);
            this.limitShortMemory();
            // 同时写入总结记忆，供 buildSummaryPrompt 使用
            this.summaries.push(summaryContent);
            this.limitSummaries();
            bumpSummaryRevision();

            // 与 add_memory 工具一致：按 memory_type/name 决定记忆归属（个人→目标用户会话，群聊→目标群会话）。
            // 模型不保证遵守模板：memories 缺失/非数组时跳过落库（摘要仍保留），逐条定位失败仅跳过该条，
            // 缺失/未知 memory_type 时兜底归属当前会话（总结的就是当前对话）
            const memoryItems = memoryData.memories;
            if (!Array.isArray(memoryItems)) {
                Logger.warning('总结记忆：模型返回的 memories 不是数组，本次不落库记忆');
            } else {
                const lastCtx = this.session.lastCtx;
                const sessionIsGroup = this.session.sessionType === 'group';
                let successCount = 0;
                let fallbackCount = 0;
                const skipped: string[] = [];
                for (const m of memoryItems) {
                    if (!m || typeof m !== 'object' || typeof m.text !== 'string' || !m.text) {
                        skipped.push('缺少 text 的记忆条目');
                        continue;
                    }
                    const normalizedVisibility: 'public' | 'private' = m.visibility === 'private' ? 'private' : 'public';
                    let targetSession: Session | null = null;
                    if (m.memory_type === 'private') {
                        // 与 add_memory 一致：name 存在时按名称定位目标用户，缺失时仅当前私聊会话可作归属
                        if (m.name) {
                            if (!lastCtx) {
                                skipped.push('无可用上下文，无法定位个人记忆目标');
                                continue;
                            }
                            const ui = await this.session.context.findUser(lastCtx, m.name, true);
                            if (ui === null) {
                                skipped.push(`未找到用户<${m.name}>`);
                                continue;
                            }
                            // 与 add_memory 工具（getSession → Agent.get('*')）一致，避免引入循环依赖
                            targetSession = Agent.get('*').sessionService.getSession(ui.userId);
                        } else if (!sessionIsGroup) {
                            targetSession = this.session;
                        } else {
                            skipped.push('缺少 name，无法定位个人记忆');
                            continue;
                        }
                    } else if (m.memory_type === 'group') {
                        if (m.name) {
                            if (!lastCtx) {
                                skipped.push('无可用上下文，无法定位群聊记忆目标');
                                continue;
                            }
                            const gi = await this.session.context.findGroup(lastCtx, m.name);
                            if (gi === null) {
                                skipped.push(`未找到群聊<${m.name}>`);
                                continue;
                            }
                            targetSession = Agent.get('*').sessionService.getSession(gi.groupId);
                        } else if (sessionIsGroup) {
                            targetSession = this.session;
                        } else {
                            skipped.push('缺少 name，无法定位群聊记忆');
                            continue;
                        }
                    } else {
                        // 缺失/未知 memory_type：兜底归属当前会话
                        if (m.memory_type) skipped.push(`未知 memory_type<${m.memory_type}>，按当前会话归属`);
                        else skipped.push('缺少 memory_type，按当前会话归属');
                        fallbackCount++;
                        targetSession = this.session;
                    }

                    // 与 add_memory 工具一致：解析相关用户/群聊名称列表；无可用上下文时跳过解析（不影响落库）
                    const uiList: UserInfo[] = [];
                    if (lastCtx) {
                        for (const n of (Array.isArray(m.userList) ? m.userList : [])) {
                            const ui = await targetSession.context.findUser(lastCtx, n, true);
                            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
                        }
                    }
                    const giList: GroupInfo[] = [];
                    if (lastCtx) {
                        for (const n of (Array.isArray(m.groupList) ? m.groupList : [])) {
                            const gi = await targetSession.context.findGroup(lastCtx, n);
                            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
                        }
                    }
                    await targetSession.memory.addMemory(null, targetSession, uiList, giList, Array.isArray(m.keywords) ? m.keywords : [], [], m.text, normalizedVisibility);
                    successCount++;
                }
                if (skipped.length > 0) {
                    Logger.warning(`总结记忆：成功写入 ${successCount} 条（含 ${fallbackCount} 条归属兜底），跳过 ${skipped.length} 条（${Array.from(new Set(skipped)).join('；')}）`);
                }
            }
        } catch (e) {
            Logger.error('更新短期记忆失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    limitSummaries() {
        const { SUMMARY_LIMIT } = Config.memory;
        if (this.summaries.length > SUMMARY_LIMIT) this.summaries.splice(0, this.summaries.length - SUMMARY_LIMIT);
    }

    clearSummaries() {
        this.summaries = [];
        bumpSummaryRevision();
    }

    buildSummaryPrompt(): string {
        if (this.summaries.length === 0) return '';
        const { SUMMARY } = Config.memory;
        return SUMMARY_TEMPLATE({
            "SUMMARY": SUMMARY,
            "summaries": this.summaries
        });
    }
}
