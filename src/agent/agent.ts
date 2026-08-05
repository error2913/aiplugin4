// 智能体（Agent）：角色配置 + 会话服务，chat() 按 use 选择模型发起对话
import Config from "../config/config";
import { ext } from "../config/config";
import { logger } from "../logger";
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
        const { content } = await streamService.sendChatRequest(messages, null, 'none');
        return content;
    }

    /**
     * 标准智能体编排：构建消息 → 请求模型 → 执行工具调用（函数调用/提示词工程）→ 回填上下文 →
     * 循环直到模型给出最终回复（带轮次上限），最后统一拆分并发送回复。
     */
    async run(session: Session, ctx: seal.MsgContext, msg: seal.Message, tool_choice?: string): Promise<void> {
        const { STATUS, PROMPT_ENGINEERING } = Config.tool;
        const toolInfos = Tool.getToolsInfo(session);
        const runCtx = new AgentRunContext();

        let result: { contextArray: string[], replyArray: string[], images: Image[] } = { contextArray: [], replyArray: [], images: [] };
        const MaxRetry = 3;
        let toolTurn = 0;

        for (let retry = 1; retry <= MaxRetry; retry++) {
            runCtx.beginTurn();
            const messages = await handleMessages(ctx, session);
            const { content: raw_reply, tool_calls } = await streamService.sendChatRequest(messages, toolInfos, tool_choice || 'auto', session.setting.modelName);
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
                        runCtx.recordToolCall();
                        const { contextArray, replyArray, images } = result;
                        await session.reply(ctx, msg, contextArray, replyArray, images);
                        await session.context.addAssistantMessage(match[0], '');
                        try {
                            const callResults = await ToolRunner.executePromptCalls(ctx, msg, session, match[1]);
                            for (const r of callResults) await session.context.addToolCallbackMessage(r.content, r.tool_call_id);
                        } catch (e) {
                            logger.error('handlePromptToolCalls error:', e.message);
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
                        runCtx.recordToolCall();
                        const { contextArray, replyArray, images } = result;
                        await session.reply(ctx, msg, contextArray, replyArray, images);
                        session.context.addToolCallsMessage(tool_calls);
                        try {
                            const callResults = await ToolRunner.executeFunctionCalls(ctx, msg, session, tool_calls);
                            for (const r of callResults) await session.context.addToolCallbackMessage(r.content, r.tool_call_id);
                        } catch (e) {
                            logger.error('handleToolCalls error:', e.message);
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
        await session.reply(ctx, msg, contextArray, replyArray, images);
        logger.info(`[run] ${runCtx.summary()}`);
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
