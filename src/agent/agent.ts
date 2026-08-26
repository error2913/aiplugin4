// 智能体（Agent）：角色配置 + 会话服务，chat() 按 use 选择模型发起对话
import Config from "../config/config";
import { ext } from "../config/config";
import Logger from "../logger";
import ChatModel from "../model/chat";
import ImageModel from "../model/image";
import Model from "../model/model";
import { ChatModelUse } from "../model/types";
import Image from "../resource/image";
import { Session } from "../session/session";
import { SessionService } from "../session/session_service";
import { ToolRunner } from "../tool/runner";
import { ToolName } from "../tool/tool";
import Tool from "../tool/tool";
import { ToolInfo } from "../tool/types";
import { requestLimiter } from "../utils/concurrency";
import { buildSystemMessage, handleMessages, RequestMessage } from "../utils/message";
import { checkRepeat, handleReply } from "../utils/string";
import { revive, TypeDescriptor } from "../utils/utils";

import { AgentRunContext } from "./run_context";
import { streamService } from "./stream";

const log = Logger.withTag('agent');

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

    /**
     * 当前会话使用的对话模型是否为多模态：
     * 1) 直接命中「图片模型」里 use=chat 的条目（ImageModel 实例）；
     * 2) 对话模型的名字出现在「图片模型」列表里（即该模型声明为视觉/多模态模型）。
     * 多模态时上下文中的图片以 image_url 内容块直接传给模型，而不是文本标签。
     */
    private isMultimodalChat(session: Session): boolean {
        const model = Model.getChatModel('chat', session.setting.modelName);
        if (!model) return false;
        if (model instanceof ImageModel) return true;
        return Model.imageModels.some(im => im.name === model.name);
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

    /** 直接发送自定义 messages（OpenAI 风格数组）到对话模型，返回回复文本；供外部插件构建消息后调用 */
    async chatMessages(messages: { role: string, content: string }[]): Promise<string> {
        const model = Model.getChatModel(this.use) as ChatModel;
        if (!model) return '';
        const { content } = await streamService.sendChatRequest(messages, [], 'none');
        return content;
    }

    /**
     * 标准智能体编排：构建消息 → 请求模型 → 执行工具调用（函数调用/提示词工程）→ 回填上下文 →
     * 循环直到模型给出最终回复（工具轮数由「允许连续调用函数次数」配置控制，0 为不限制），最后统一拆分并发送回复。
     */
    async run(session: Session, ctx: seal.MsgContext, msg: seal.Message, tool_choice?: string): Promise<void> {
        // 启动前捕获 stopVersion：.ai stop 发生在排队期间或拿到许可瞬间都会因版本变化而中止
        const version = session.stopVersion;
        if (!(await requestLimiter.acquire(session.sessionId))) return;
        try {
            if (session.stopVersion !== version) return;
            session.running = true;
            await this.runInternal(session, ctx, msg, tool_choice);
        } finally {
            session.running = false;
            requestLimiter.release();
        }
    }

    private async runInternal(session: Session, ctx: seal.MsgContext, msg: seal.Message, tool_choice?: string): Promise<void> {
        const { STATUS, PROMPT_ENGINEERING } = Config.tool;
        const toolInfos = Tool.getToolsInfo(session);
        const trace = new AgentRunContext();
        const version = session.stopVersion;

        // system prompt 在同一轮工具循环内复用：避免每轮工具回调后重复做记忆检索/嵌入，
        // 只在工具回调后更新 context messages（上下文仍随工具结果增长）。
        const systemMessage = await buildSystemMessage(ctx, session);

        let result: { contextArray: string[], replyArray: string[], images: Image[] } = { contextArray: [], replyArray: [], images: [] };
        const MaxRetry = 3;
        // 最后一轮模型响应的思维链：无工具轮次时随最终回复一并入库（见下方最终 session.reply）
        let lastReasoning: string | undefined;
        // dsh 式 turn-stopping 检查点：上一轮是否执行过工具（行为信号），以及续跑提示次数上限
        let lastTurnHadTools = false;
        let nudgeCount = 0;
        const MaxNudge = 2;

        for (let retry = 1; retry <= MaxRetry; retry++) {
            // stop 中止检查点：上一轮工具执行/回调期间被 stop 则不再发下一轮请求
            if (session.stopVersion !== version) return;
            trace.beginTurn();
            const messages = await handleMessages(ctx, session, this.isMultimodalChat(session), toolInfos || [], systemMessage);
            this.injectSteers(session, messages);
            const { content: raw_reply, tool_calls, reasoning_content } = await streamService.sendChatRequest(messages, toolInfos || [], tool_choice || 'auto', session.setting.modelName, trace.runId);
            // stop 中止检查点：模型请求期间被 stop，丢弃本轮输出直接中止
            if (session.stopVersion !== version) return;
            lastReasoning = reasoning_content;
            // 提示词工程模式下模型可能返回 ```function ... ``` 代码块包裹的工具调用：
            // 发送前先剥离该块，避免代码块原文进入回复/上下文；调用内容仍以 match[0] 原样记录
            const promptCallMatch: RegExpMatchArray | null = (STATUS && PROMPT_ENGINEERING)
                ? raw_reply.match(/```function([\s\S]*?)```/)
                : null;
            result = await handleReply(ctx, msg, session, promptCallMatch ? raw_reply.slice(0, promptCallMatch.index ?? 0) : raw_reply);
            if (session.stopVersion !== version) return;

            if (STATUS) {
                if (PROMPT_ENGINEERING) {
                    const match = promptCallMatch;
                    if (match) {
                        log.info('prompt tool call triggered');
                        const { contextArray, replyArray, images } = result;
                        await session.reply(ctx, msg, contextArray, replyArray, images, { withSegmentDelay: true });
                        await session.context.addAssistantMessage(match[0], '', reasoning_content);
                        const callTime = Date.now();
                        try {
                            const callResults = await ToolRunner.executePromptCalls(ctx, msg, session, match[1]);
                            // stop 中止检查点：工具执行期间被 stop，不再回调/续轮
                            if (session.stopVersion !== version) return;
                            for (const r of callResults) {
                                if (r.callBack !== false) await session.context.addToolCallbackMessage(r.content, r.tool_call_id, r.toolName, r.searchTarget, r.contentParts);
                            }
                            if (callResults.length > 0 && callResults.every(r => r.callBack === false)) {
                                log.info('工具执行完成且不回调（callBack=false），结束本轮编排');
                                result = { contextArray: [], replyArray: [], images: [] };
                                break;
                            }
                            trace.recordToolCall('prompt-call', Date.now() - callTime, true);
                        } catch (e) {
                            log.exception('handlePromptToolCalls error', e);
                            trace.recordToolCall('prompt-call', Date.now() - callTime, false, e instanceof Error ? e.message : String(e));
                        }
                        lastTurnHadTools = true;
                        retry = 0;
                        continue;
                    }
                } else {
                    if (tool_calls.length > 0) {
                        log.info('tool call triggered');
                        const { contextArray, replyArray, images } = result;
                        await session.reply(ctx, msg, contextArray, replyArray, images, { withSegmentDelay: true }, reasoning_content);
                        session.context.addToolCallsMessage(tool_calls, reasoning_content);
                        const callTime = Date.now();
                        try {
                            const callResults = await ToolRunner.executeFunctionCalls(ctx, msg, session, tool_calls);
                            // stop 中止检查点：工具执行期间被 stop，不再回调/续轮
                            if (session.stopVersion !== version) return;
                            for (const r of callResults) {
                                if (r.callBack !== false) await session.context.addToolCallbackMessage(r.content, r.tool_call_id, r.toolName, r.searchTarget, r.contentParts);
                            }
                            if (callResults.length > 0 && callResults.every(r => r.callBack === false)) {
                                log.info('工具执行完成且不回调（callBack=false），结束本轮编排');
                                result = { contextArray: [], replyArray: [], images: [] };
                                break;
                            }
                            trace.recordToolCall('function-call', Date.now() - callTime, true);
                        } catch (e) {
                            log.exception('handleToolCalls error', e);
                            trace.recordToolCall('function-call', Date.now() - callTime, false, e instanceof Error ? e.message : String(e));
                        }
                        lastTurnHadTools = true;
                        retry = 0;
                        continue;
                    }
                }
            }

            if (checkRepeat(session.context, result.contextArray.join('')) && result.replyArray.join('').trim()) {
                if (retry >= MaxRetry) {
                    log.warning('repeat detected, clear assistant/tool messages');
                    session.context.clearMessages('assistant', 'tool');
                    break;
                }
                log.warning(`repeat detected, retry [${retry}/${MaxRetry}]`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            // dsh 式 turn-stopping 检查点：上一轮执行过工具 && 本轮无工具调用（只说方向/罢工）
            // → 注入续跑提示再转一轮，最多 MaxNudge 次；正常“工具→最终回答”也会被推一次（dsh 方案本身的设计代价）
            if (lastTurnHadTools && nudgeCount < MaxNudge) {
                nudgeCount++;
                lastTurnHadTools = false;
                session.context.addSystemUserMessage(
                    '你上一轮只给了文字，没有给出工具调用块。若任务未完成，请直接给出工具调用块继续干活；若已完成，请明确回复“任务完成”。',
                    '任务续跑提示'
                );
                retry = 0;
                continue;
            }
            break;
        }

        if (session.stopVersion !== version) return;
        const { contextArray, replyArray, images } = result;
        await session.reply(ctx, msg, contextArray, replyArray, images, { withSegmentDelay: true }, lastReasoning);
        log.info(`[run] ${trace.summary()}`);
    }

    /** 把 .ai steer 注入的方向提示追加到请求消息末尾（最新指令），并清空队列；不写入持久化上下文 */
    private injectSteers(session: Session, messages: RequestMessage[]): void {
        const steers = session.drainSteers();
        for (const steer of steers) {
            messages.push({ role: 'system', content: `【方向提示】${steer}` });
        }
    }

    /** 流式编排：与 run() 同层的流式循环（start → poll → 工具调用 → 递归续流），工具轮数由配置控制 */
    async runStream(session: Session, ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const version = session.stopVersion;
        if (!(await requestLimiter.acquire(session.sessionId))) return;
        try {
            if (session.stopVersion !== version) return;
            session.running = true;
            await this.runStreamInner(session, ctx, msg);
        } finally {
            session.running = false;
            requestLimiter.release();
        }
    }

    private async runStreamInner(
        session: Session,
        ctx: seal.MsgContext,
        msg: seal.Message,
        systemMessage?: Awaited<ReturnType<typeof buildSystemMessage>>
    ): Promise<void> {
        const { STATUS, PROMPT_ENGINEERING } = Config.tool;
        const trace = new AgentRunContext();
        const version = session.stopVersion;

        await session.stopCurrentChatStream();

        const sys = systemMessage ?? await buildSystemMessage(ctx, session);
        const messages = await handleMessages(ctx, session, this.isMultimodalChat(session), undefined, sys);
        this.injectSteers(session, messages);
        const id = await streamService.startStream(messages, session.setting.modelName, trace.runId);
        if (!id) return;
        // stop 发生在 startStream 期间：结束刚建的新流并中止，避免轮询一个未被 stop 的流
        if (session.stopVersion !== version) {
            session.stream.id = id;
            await session.stopCurrentChatStream();
            return;
        }

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
            log.debug('stream reply:', raw_reply.length > 200 ? raw_reply.slice(0, 200) + `…(+${raw_reply.length - 200})` : raw_reply);

            if (STATUS && PROMPT_ENGINEERING) {
                if (!session.stream.toolCallStatus && /```function/.test(session.stream.reply + raw_reply)) {
                    log.info('tool call start tag found');
                    const match = raw_reply.match(/([\s\S]*)```function/);
                    if (match && match[1].trim()) {
                        const { contextArray, replyArray, images } = await handleReply(ctx, msg, session, match[1]);
                        if (session.stream.id !== id) return;
                        await session.reply(ctx, msg, contextArray, replyArray, images, { withSegmentDelay: true });
                    }
                    session.stream.reply = '';
                    session.stream.toolCallStatus = true;
                }

                if (session.stream.id !== id) return;

                if (session.stream.toolCallStatus) {
                    session.stream.reply += raw_reply;

                    // 结束围栏 ``` 与起始围栏 ```function 区分：从起始围栏后取到首个 ``` 即视为调用块结束
                    const match = session.stream.reply.match(/```function([\s\S]*?)```/);
                    if (match) {
                        log.info('tool call end tag found');
                        session.stream.reply = '';
                        session.stream.toolCallStatus = false;
                        await session.stopCurrentChatStream();

                        await session.context.addAssistantMessage(match[0], '');

                        try {
                            trace.recordToolCall('stream-tool-call', 0, true);
                            const callResults = await ToolRunner.executePromptCalls(ctx, msg, session, match[1]);
                            // stop 中止检查点：工具执行期间被 stop，不递归续流，直接中止工具链
                            if (session.stopVersion !== version) return;
                            for (const r of callResults) {
                                if (r.callBack !== false) await session.context.addToolCallbackMessage(r.content, r.tool_call_id, r.toolName, r.searchTarget, r.contentParts);
                            }
                            if (callResults.length > 0 && callResults.every(r => r.callBack === false)) {
                                log.info('工具执行完成且不回调（callBack=false），结束本轮编排');
                                log.info(`[run] ${trace.summary()}`);
                                return;
                            }
                        } catch (e) {
                            log.exception('handlePromptToolCalls error', e);
                            return;
                        }

                        if (session.stopVersion !== version) return;
                        await this.runStreamInner(session, ctx, msg, sys);
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
            await session.reply(ctx, msg, contextArray, replyArray, images, { withSegmentDelay: true });

            after = result.nextAfter;
            await new Promise(resolve => setTimeout(resolve, interval));
        }

        if (session.stream.id !== id) return;
        await session.stopCurrentChatStream();
        log.info(`[run] ${trace.summary()}`);
    }

    static agentMap: { [key: string]: Agent } = {};

    static get(name: string): Agent {
        if (!Object.prototype.hasOwnProperty.call(this.agentMap, name)) {
            let agent = new Agent();
            try {
                const data = JSON.parse(ext.storageGet(`agent_${name}`) || '{}');
                agent = revive(Agent, data);
            } catch (error) {
                log.exception('加载智能体' + name, error);
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
