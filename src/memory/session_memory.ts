// 会话记忆：短期记忆总结（调用摘要智能体）与记忆 prompt 构建
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { Session } from "../session/session";
import { buildContent } from "../utils/message";
import { TypeDescriptor } from "../utils/utils";

import MemoryService from "./memory";
import MemoryItem from "./memory_item";

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
        if (!this.summaryStatus) return;

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
            const roleSetting = (Config.message.INSTRUCTIONS || [])[0] || '';
            const prompt = Config.prompt.SUMMARY_PROMPT_TEMPLATE({
                "角色设定": roleSetting,
                "平台": '',
                "私聊": this.session.sessionType !== 'group',
                "展示号码": false,
                "用户名称": '',
                "用户号码": '',
                "群聊名称": this.session.sessionType === 'group' ? this.session.sessionId : '',
                "群聊号码": '',
                "添加前缀": false,
                "展示消息ID": false,
                "展示时间": false,
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
                }[]
            };

            this.shortMemoryList.push(memoryData.content);
            this.limitShortMemory();

            memoryData.memories.forEach(m => {
                this.addMemory(null, this.session, [], [], m.keywords || [], [], m.text);
            });
        } catch (e) {
            Logger.error('更新短期记忆失败: ' + e.message);
        }
    }

    limitSummaries() {
        const { SUMMARY_LIMIT } = Config.memory;
        if (this.summaries.length > SUMMARY_LIMIT) this.summaries.splice(0, this.summaries.length - SUMMARY_LIMIT);
    }

    clearSummaries() {
        this.summaries = [];
    }

    buildSummaryPrompt(): string {
        if (this.summaries.length === 0) return '';
        const { SUMMARY } = Config.memory;
        const { SUMMARY_TEMPLATE } = Config.prompt;
        return SUMMARY_TEMPLATE({
            "SUMMARY": SUMMARY,
            "summaries": this.summaries
        });
    }
}
