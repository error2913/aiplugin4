import { Config } from "../config/config";
import { logger } from "../logger";
import { TypeDescriptor } from "../utils/utils";
import MemoryService from "./memory";
import { MemoryItem } from "./memory_item";

export default class SessionMemoryService extends MemoryService {
    static validKeysMap: { [key in keyof SessionMemoryService]?: TypeDescriptor<SessionMemoryService[key]> } = {
        memoryMap: { array: MemoryItem },
        summaryStatus: 'boolean',
        summaries: { array: 'string' }
    };
    summaryStatus: boolean;
    summaries: string[];

    constructor() {
        super();
        this.summaryStatus = false;
        this.summaries = [];
    }

    // wip 使用总结智能体
    async summarize(session: Session) {
        if (!this.summaryStatus) return;

        const { url: chatUrl, apiKey: chatApiKey } = Config.request;
        const { isPrefix, showNumber, showMsgId, showTime } = Config.message;
        const { shortMemorySummaryRound, memoryUrl, memoryApiKey, memoryBodyTemplate, memoryPromptTemplate } = Config.memory;

        const { roleSetting } = getRoleSetting(ctx);

        const messages = ai.context.messages;
        let sumMessages = messages.slice();
        let round = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user' && !messages[i].name.startsWith('_')) {
                round++;
            }
            if (round > shortMemorySummaryRound) {
                sumMessages = messages.slice(0, i); // 只保留最近的shortMemorySummaryRound轮对话
                break;
            }
        }

        if (sumMessages.length === 0) {
            return;
        }

        let url = chatUrl;
        let apiKey = chatApiKey;
        if (memoryUrl.trim()) {
            url = memoryUrl;
            apiKey = memoryApiKey;
        }

        try {
            const prompt = memoryPromptTemplate({
                "角色设定": roleSetting,
                "平台": ctx.endPoint.platform,
                "私聊": ctx.isPrivate,
                "展示号码": showNumber,
                "用户名称": ctx.player.name,
                "用户号码": ctx.player.userId.replace(/^.+:/, ''),
                "群聊名称": ctx.group.groupName,
                "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
                "添加前缀": isPrefix,
                "展示消息ID": showMsgId,
                "展示时间": showTime,
                "对话内容": isPrefix ? sumMessages.map(message => {
                    if (message.role === 'assistant' && message?.tool_calls && message?.tool_calls.length > 0) {
                        return `\n[function_call]: ${message.tool_calls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
                    }

                    return `[${message.role}]: ${buildContent(message)}`;
                }).join('\n') : JSON.stringify(sumMessages)
            })

            logger.info(`记忆总结prompt:\n`, prompt);

            const messages = [
                {
                    role: "system",
                    content: prompt
                }
            ]
            const bodyObject = parseBody(memoryBodyTemplate, messages, [], "none");

            const time = Date.now();
            const data = await fetchData(url, apiKey, bodyObject);

            if (data.choices && data.choices.length > 0) {
                AIManager.updateUsage(data.model, data.usage);

                const message = data.choices[0].message;
                const finish_reason = data.choices[0].finish_reason;

                if (message.hasOwnProperty('reasoning_content')) {
                    logger.info(`思维链内容:`, message.reasoning_content);
                }

                const reply = message.content || '';
                logger.info(`响应内容:`, reply, '\nlatency:', Date.now() - time, 'ms', '\nfinish_reason:', finish_reason);

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
                    Tool.toolMap["add_memory"].solve(ctx, msg, ai, m);
                });
            }
        } catch (e) {
            logger.error(`更新短期记忆失败: ${e.message}`);
        }
    }

    limitSummaries() {
        const { SUMMARY_LIMIT } = Config.memory;
        if (this.summaries.length > SUMMARY_LIMIT) this.summaries.splice(0, this.summaries.length - SUMMARY_LIMIT);
    }

    clearSummaries() {
        this.summaries = [];
    }
}