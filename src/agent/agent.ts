// 智能体（Agent）：角色配置 + 会话服务，chat() 按 use 选择模型发起对话
import Config from "../config/config";
import { ext } from "../config/config";
import Logger, { logger } from "../logger";
import ChatModel from "../model/chat";
import Model from "../model/model";
import { ChatModelUse } from "../model/types";
import Image from "../resource/image";
import { Session } from "../session/session";
import { SessionService } from "../session/session_service";
import { ToolRunner } from "../tool/runner";
import { ToolName } from "../tool/tool";
import Tool from "../tool/tool";
import { ToolInfo } from "../tool/types";
import { handleMessages } from "../utils/message";
import { checkRepeat, handleReply } from "../utils/string";
import { revive, TypeDescriptor } from "../utils/utils";

import { AgentRunContext } from "./run_context";
import { streamService } from "./stream";

// 单次对话中允许的连续工具调用轮次上限（防止模型无限调用工具）
export const MAX_TOOL_TURNS = 10;

export default class Agent {
    static validKeysMap: { [key in keyof Agent]?: TypeDescriptor<Agent[key]> } = {
        sessionService: SessionService,
        tools: { array: 'string' },
        subAgents: { array: 'string' }
    }

    name: string;
    description: string;
    instruction: string | ((sessionService: SessionService) => string);
    use: ChatModelUse;

    sessionService: SessionService;
    tools: ToolName[];
    subAgents: string[];

    constructor() {
        this.name = "";
        this.description = "";
        this.instruction = "";
        this.use = "chat";
        this.sessionService = new SessionService();
        this.sessionService.agentName = this.name;
        this.tools = [];
        this.subAgents = [];
    }

    getRequestTools(session?: Session): ToolInfo[] | null {
        if (session) return Tool.getToolsInfo(session);
        return null;
    }

    async chat(prompt: string): Promise<string> {
        const model = Model.getChatModel(this.use) as ChatModel;
        if (!model) return '';
        const messages: { role: string, content: string }[] = [];
        if (this.instruction) {
            messages.push({
                role: 'system',
                content: typeof this.instruction === 'function' ? this.instruction(this.sessionService) : this.instruction
            });
        }
        messages.push({ role: 'user', content: prompt });
        const { content } = await streamService.sendChatRequest(messages, [], 'none');
        return content;
    }

    /**
     * 标准智能体编排：构建消息 → 请求模型 → 执行工具调用（函数调用/提示词工程）→ 回填上下文 →
     * 循环直到模型给出最终回复（带轮次上限），最后统一拆分并发送回复。
     */
    async run(session: Session, ctx: seal.MsgContext, msg: seal.Message, tool_choice?: string): Promise<void> {
        const { STATUS, PROMPT_ENGINEERING } = Config.tool;
        const toolInfos = Tool.getToolsInfo(session);
        const trace = new AgentRunContext();

        let result: { contextArray: string[], replyArray: string[], images: Image[] } = { contextArray: [], replyArray: [], images: [] };
        const MaxRetry = 3;
        let toolTurn = 0;

        for (let retry = 1; retry <= MaxRetry; retry++) {
            trace.beginTurn();
            const messages = await handleMessages(ctx, session);
            const { content: raw_reply, tool_calls } = await streamService.sendChatRequest(messages, toolInfos || [], tool_choice || 'auto', session.setting.modelName);
            result = await handleReply(ctx, msg, session, raw_reply);

            if (STATUS) {
                if (PROMPT_ENGINEERING) {
                    const match = raw_reply.match(/<[\||｜]?function(?:_call)?>([\s\S]*)<\/function(?:_call)?>/);
                    if (match) {
                        if (toolTurn >= MAX_TOOL_TURNS) {
                            logger.warning(`工具调用轮次超限（${MAX_TOOL_TURNS}），停止继续调用`);
                            break;
                        }
                        logger.info('prompt tool call triggered');
                        const { contextArray, replyArray, images } = result;
                        await session.reply(ctx, msg, contextArray, replyArray, images, { withNonStreamDelay: true });
                        await session.context.addAssistantMessage(match[0], '');
                        const callTime = Date.now();
                        try {
                            const callResults = await ToolRunner.executePromptCalls(ctx, msg, session, match[1]);
                            for (const r of callResults) await session.context.addToolCallbackMessage(r.content, r.tool_call_id, r.toolName, r.searchTarget);
                            trace.recordToolCall('prompt-call', Date.now() - callTime, true);
                        } catch (e) {
                            Logger.exception('handlePromptToolCalls error', e);
                            trace.recordToolCall('prompt-call', Date.now() - callTime, false, e instanceof Error ? e.message : String(e));
                        }
                        session.tool.callCount = 0;
                        toolTurn++;
                        retry = 0;
                        continue;
                    }
                } else {
                    if (tool_calls.length > 0) {
                        if (toolTurn >= MAX_TOOL_TURNS) {
                            logger.warning(`工具调用轮次超限（${MAX_TOOL_TURNS}），停止继续调用`);
                            break;
                        }
                        logger.info('tool call triggered');
                        const { contextArray, replyArray, images } = result;
                        await session.reply(ctx, msg, contextArray, replyArray, images, { withNonStreamDelay: true });
                        session.context.addToolCallsMessage(tool_calls);
                        const callTime = Date.now();
                        try {
                            const callResults = await ToolRunner.executeFunctionCalls(ctx, msg, session, tool_calls);
                            for (const r of callResults) await session.context.addToolCallbackMessage(r.content, r.tool_call_id, r.toolName, r.searchTarget);
                            trace.recordToolCall('function-call', Date.now() - callTime, true);
                        } catch (e) {
                            Logger.exception('handleToolCalls error', e);
                            trace.recordToolCall('function-call', Date.now() - callTime, false, e instanceof Error ? e.message : String(e));
                        }
                        session.tool.callCount = 0;
                        toolTurn++;
                        retry = 0;
                        continue;
                    }
                }
            }

            if (checkRepeat(session.context, result.contextArray.join('')) && result.replyArray.join('').trim()) {
                if (retry >= MaxRetry) {
                    logger.warning('repeat detected, clear assistant/tool messages');
                    session.context.clearMessages('assistant', 'tool');
                    break;
                }
                logger.warning(`repeat detected, retry [${retry}/${MaxRetry}]`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            break;
        }

        const { contextArray, replyArray, images } = result;
        await session.reply(ctx, msg, contextArray, replyArray, images, { withNonStreamDelay: true });
        logger.info(`[run] ${trace.summary()}`);
    }

    /** 流式编排：与 run() 同层的流式循环（start → poll → 工具调用 → 递归续流），带轮次上限 */
    async runStream(session: Session, ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const { STATUS, PROMPT_ENGINEERING } = Config.tool;
        const trace = new AgentRunContext();
        let turns = 0;

        await session.stopCurrentChatStream();

        const messages = await handleMessages(ctx, session);
        const id = await streamService.startStream(messages, session.setting.modelName);
        if (!id) return;

        session.stream.id = id;
        let status = 'processing';
        let after = 0;
        let interval = 1000;

        while (status === 'processing' && session.stream.id === id) {
            trace.beginTurn();
            const result = await streamService.pollStream(session.stream.id, after);
            status = result.status;
            const raw_reply = result.reply;

            if (raw_reply.length <= 8) interval = 1500;
            else if (raw_reply.length <= 20) interval = 1000;
            else if (raw_reply.length <= 30) interval = 500;
            else interval = 200;

            if (raw_reply.trim() === '') {
                after = result.nextAfter;
                await new Promise(resolve => setTimeout(resolve, interval));
                continue;
            }
            logger.info('stream reply:', raw_reply.length > 200 ? raw_reply.slice(0, 200) + `…(+${raw_reply.length - 200})` : raw_reply);

            if (STATUS && PROMPT_ENGINEERING) {
                if (!session.stream.toolCallStatus && /<[\||｜]?function(?:_call)?>/.test(session.stream.reply + raw_reply)) {
                    logger.info('tool call start tag found');
                    const match = raw_reply.match(/([\s\S]*)<[\||｜]?function(?:_call)?>/);
                    if (match && match[1].trim()) {
                        const { contextArray, replyArray, images } = await handleReply(ctx, msg, session, match[1]);
                        if (session.stream.id !== id) return;
                        await session.reply(ctx, msg, contextArray, replyArray, images);
                    }
                    session.stream.toolCallStatus = true;
                }

                if (session.stream.id !== id) return;

                if (session.stream.toolCallStatus) {
                    session.stream.reply += raw_reply;

                    if (/<\/function(?:_call)?>/.test(session.stream.reply)) {
                        logger.info('tool call end tag found');
                        const match = session.stream.reply.match(/<[\||｜]?function(?:_call)?>([\s\S]*)<\/function(?:_call)?>/);
                        if (match) {
                            session.stream.reply = '';
                            session.stream.toolCallStatus = false;
                            await session.stopCurrentChatStream();

                            await session.context.addAssistantMessage(match[0], '');

                            try {
                                trace.recordToolCall('stream-tool-call', 0, true);
                                turns++;
                                if (turns >= MAX_TOOL_TURNS) {
                                    logger.warning(`工具调用轮次超限（${MAX_TOOL_TURNS}），停止继续调用`);
                                    return;
                                }
                                const callResults = await ToolRunner.executePromptCalls(ctx, msg, session, match[1]);
                                for (const r of callResults) await session.context.addToolCallbackMessage(r.content, r.tool_call_id, r.toolName, r.searchTarget);
                            } catch (e) {
                                logger.error('handlePromptToolCalls error:', e instanceof Error ? e.message : String(e));
                                return;
                            }

                            await this.runStream(session, ctx, msg);
                            return;
                        }
                        await session.stopCurrentChatStream();
                        return;
                    } else {
                        after = result.nextAfter;
                        await new Promise(resolve => setTimeout(resolve, interval));
                        continue;
                    }
                }
            }

            const { contextArray, replyArray, images } = await handleReply(ctx, msg, session, raw_reply);
            if (session.stream.id !== id) return;
            session.reply(ctx, msg, contextArray, replyArray, images);

            after = result.nextAfter;
            await new Promise(resolve => setTimeout(resolve, interval));
        }

        if (session.stream.id !== id) return;
        await session.stopCurrentChatStream();
        logger.info(`[run] ${trace.summary()}`);
    }

    static agentMap: { [key: string]: Agent } = {};

    static get(name: string): Agent {
        if (!Object.prototype.hasOwnProperty.call(this.agentMap, name)) {
            let agent = new Agent();
            try {
                const data = JSON.parse(ext.storageGet(`agent_${name}`) || '{}');
                agent = revive(Agent, data);
            } catch (error) {
                logger.error(`加载智能体${name}失败: ${error}`);
            }
            agent.name = name;
            agent.sessionService.agentName = name;
            this.agentMap[name] = agent;
        }
        return this.agentMap[name];
    }

    static save(agent: Agent) {
        ext.storageSet(`agent_${agent.name}`, JSON.stringify(agent));
    }

}
