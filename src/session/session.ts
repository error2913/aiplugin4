// 会话：聊天编排（chat/chatStream/回复/接收）、设定、工具状态与活跃时间
import Agent from "../agent/agent";
import { streamService } from "../agent/stream";
import { ext } from "../config/config";
import Config from "../config/config";
import { Context } from "../context/context";
import { JudgeManager } from "../judge/judge_manager";
import { logger } from "../logger";
import SessionMemoryService from "../memory/session_memory";
import Model from "../model/model";
import Image from "../resource/image";
import { TimerManager } from "../timer";
import { ToolState } from "../tool/tool";
import { toolMap } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { requestLimiter } from "../utils/concurrency";
import { MessageSegment, normalizeRenderTags, transformArrayToContent } from "../utils/string";
import { createStopEvent, fireStopEvent, StopEvent, TypeDescriptor } from "../utils/utils";
import { getRecordMessageId, replyToSender } from "../utils/utils";

import Group from "./group";
import { createToolListen } from "./tool_listen";
import { SessionType, State } from "./types";
import User from "./user";

const log = logger.withTag('session');

/** 持久化时排除的运行时字段（监听器/运行状态/挂起队列等），不写入存储、不参与 revive 恢复 */
export const SESSION_RUNTIME_KEYS = new Set(['lastCtx', 'running', 'starting', 'stopVersion', 'pendingQueue', 'activeRuns', 'stopEvent']);

/** 会话忙时挂起的消息：运行中收到的新消息先入队，由下一轮模型请求前统一入库（触发类可在链结束后续跑一轮） */
export interface PendingMessage {
    ctx: seal.MsgContext;
    msg: seal.Message;
    content: string;
    userId: string;
    messageId: string;
    kind: 'trigger' | 'record';
    systemReason?: string;
    /** 落盘轻量字段：重载后用于重建 ctx/msg（getSessionCtxAndMsg）与续跑 */
    epId: string;
    isPrivate: boolean;
}

export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo', 'modelName', 'regexTrigger', 'judge'];
    static validKeysMap: { [key in keyof Setting]?: TypeDescriptor<Setting[key]> } = {
        priv: 'number',
        standby: 'boolean',
        counter: 'number',
        timer: 'number',
        prob: 'number',
        regexTrigger: 'boolean',
        judge: 'boolean',
        modelName: 'string',
        activeTimeInfo: { objectValue: 'any' }
    }
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
    regexTrigger: boolean;
    judge: boolean;
    modelName: string;
    activeTimeInfo: {
        start: number;
        end: number;
        segs: number;
    }

    constructor() {
        this.priv = 0;
        this.standby = false;
        this.counter = -1;
        this.timer = -1;
        this.prob = -1;
        this.regexTrigger = true;
        this.judge = false;
        this.modelName = '';
        this.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0
        }
    }
}

export class Session {
    static validKeysMap: { [key in keyof Session]?: TypeDescriptor<Session[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        sessionType: 'string',
        state: {
            object: {
                description: 'string',
                impression: 'string',
            },
            objectValue: 'any'
        },
        context: Context,
        memory: SessionMemoryService,
        setting: Setting,
        stream: {
            object: {
                id: 'string',
                reply: 'string',
                toolCallStatus: 'boolean'
            },
            objectValue: 'any'
        },
        bucket: {
            object: {
                count: 'number',
                lastTime: 'number'
            },
            objectValue: 'any'
        },
        tool: {
            object: {
                state: { objectValue: 'boolean' }
            },
            objectValue: 'default'
        }
    }
    agentName: string;
    sessionId: string;
    sessionType: SessionType;
    state: State;
    context: Context;
    memory: SessionMemoryService;
    setting: Setting;
    stream: {
        id: string,
        reply: string,
        toolCallStatus: boolean
    }
    bucket: {
        count: number,
        lastTime: number
    }
    lastCtx: seal.MsgContext | null = null;
    /** 运行时字段：当前是否有 run/runStream 在跑（含工具执行阶段；不持久化） */
    running = false;
    /** 运行时字段：stop 时自增，运行循环启动时捕获、检测到变化即中止（不持久化） */
    stopVersion = 0;
    /** 运行时字段：本会话正在启动 run/runStream（含在请求并发队列中等待时）；置位后同会话新消息一律挂起（不持久化） */
    starting = false;
    /** 运行时字段：会话忙（starting/running）时挂起的待入库消息队列，下一轮模型请求前统一入库（不持久化） */
    pendingQueue: PendingMessage[] = [];
    /** 运行时字段：本会话当前在跑的 run/runStream 请求数（同会话并发重叠时 >1；不持久化） */
    activeRuns = 0;
    /** 运行时字段：会话级停止信号（stop 时 fired=true 并同步唤醒等待者，用于打断进行中的模型请求/工具链；不持久化） */
    stopEvent: StopEvent = createStopEvent();
    tool: {
        state: ToolState,
        callCount: number, // 单次触发调用函数计数
        listen: ToolListen // 监听调用函数发送的内容
    }

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.sessionType = 'group';
        this.state = {
            description: '',
            impression: '',
        };
        this.context = new Context();
        this.setting = new Setting();
        this.stream = {
            id: '',
            reply: '',
            toolCallStatus: false
        }
        this.bucket = {
            count: 0,
            lastTime: 0
        }
        this.memory = new SessionMemoryService();
        this.lastCtx = null;
        this.running = false;
        this.stopVersion = 0;
        this.starting = false;
        this.pendingQueue = [];
        this.activeRuns = 0;
        this.stopEvent = createStopEvent();
        const listen = createToolListen();
        this.tool = {
            state: {} as ToolState,
            callCount: 0,
            listen
        }
    }

    get agent(): Agent {
        return Agent.get(this.agentName);
    }
    get user(): User | null {
        return this.sessionType === 'user' ? User.get(this.sessionId) : null;
    }
    get group(): Group | null {
        return this.sessionType === 'group' ? Group.get(this.sessionId) : null;
    }
    get toolState(): ToolState {
        const { BLOCKED, DEFAULT_CLOSED } = Config.tool;
        const state = this.tool.state;
        // 清理已不存在工具的残留状态（如已删除的 call_subagent）
        for (const key of Object.keys(state)) {
            if (!Object.prototype.hasOwnProperty.call(toolMap, key)) delete state[key];
        }
        Object.keys(toolMap).forEach(tool => {
            if (BLOCKED.includes(tool)) return;
            if (!Object.prototype.hasOwnProperty.call(state, tool)) state[tool] = !DEFAULT_CLOSED.includes(tool);
        })
        return state;
    }

    checkIgnoredUserId(userId: string): boolean {
        return this.sessionType === 'group' && Group.get(this.sessionId).ignoredUserIdList.includes(userId);
    }

    get id(): string {
        return this.sessionId;
    }

    resetState() {
        if (this.context.timer) clearTimeout(this.context.timer);
        this.context.timer = null;
        this.context.counter = 0;
        this.tool.callCount = 0;
    }

    save() {
        ext.storageSet(`session_${this.sessionId}`, JSON.stringify(this, (key, value) => SESSION_RUNTIME_KEYS.has(key) ? undefined : value));
    }

    /** 挂起队列轻量分片 key：ctx/msg 是运行时对象不可序列化，只落盘重建所需字段，变更即写穿 */
    static pendingKey(sessionId: string): string {
        return `session_${sessionId}:pending`;
    }

    savePending() {
        const light = this.pendingQueue.map(p => ({
            content: p.content,
            userId: p.userId,
            messageId: p.messageId,
            kind: p.kind,
            systemReason: p.systemReason,
            epId: p.epId,
            isPrivate: p.isPrivate,
        }));
        ext.storageSet(Session.pendingKey(this.sessionId), JSON.stringify(light));
    }

    /** 清空挂起队列分片：空队列即清空存档，避免重载后残留脏数据复活 */
    clearPending() {
        ext.storageSet(Session.pendingKey(this.sessionId), '');
    }

    get curActiveTimeSegIndex(): number {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const { start, end, segs } = this.setting.activeTimeInfo;
        const endReal = end >= start ? end : end + 24 * 60;
        const curReal = cur >= start ? cur : cur + 24 * 60;

        if (curReal >= endReal) return -1;

        const segLen = (endReal - start) / segs;
        const index = Math.floor((curReal - start) / segLen);
        return Math.min(index, segs - 1);
    }

    getNextTimePoint(curSegIndex: number): number {
        const { start, end, segs } = this.setting.activeTimeInfo;

        if (start === 0 && end === 0) return -1;

        const endReal = end >= start ? end : end + 24 * 60;
        const segLen = (endReal - start) / segs;
        const nextSegIndex = (curSegIndex + 1) % segs;
        const todayMin = Math.floor(start + nextSegIndex * segLen + Math.random() * segLen) % (24 * 60);

        const nextTime = new Date();
        nextTime.setHours(Math.floor(todayMin / 60), todayMin % 60, Math.floor(Math.random() * 60), 0);

        if (nextTime.getTime() <= Date.now()) {
            nextTime.setDate(nextTime.getDate() + 1);
        }

        return Math.floor(nextTime.getTime() / 1000);
    }

    checkActiveTimer(ctx: seal.MsgContext) {
        const { segs, start, end } = this.setting.activeTimeInfo;
        if (segs !== 0 && (start !== 0 || end !== 0)) {
            const timers = TimerManager.getTimers(this.sessionId, '', ['activeTime']);
            if (timers.length === 0) {
                const curSegIndex = this.curActiveTimeSegIndex;
                const nextTimePoint = this.getNextTimePoint(curSegIndex);
                if (nextTimePoint !== -1) TimerManager.addActiveTimeTimer(ctx, this, nextTimePoint);
                else log.error('active time timer add failed');
            }
        }
    }

    async handleReceipt(ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[]) {
        this.lastCtx = ctx;
        const { content } = await transformArrayToContent(ctx, messageArray);
        await this.context.addUserMessage(ctx, content, ctx.player!.userId, getRecordMessageId(ctx, msg));
    }

    /** 会话忙时挂起消息：与 handleReceipt 等价但不入库，进入 pendingQueue 由 flushPending 统一处理（不触发并发） */
    async deferReceipt(ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[], kind: 'trigger' | 'record', systemReason?: string) {
        this.lastCtx = ctx;
        const { content } = await transformArrayToContent(ctx, messageArray);
        this.pendingQueue.push({
            ctx,
            msg,
            content,
            userId: ctx.player!.userId,
            messageId: getRecordMessageId(ctx, msg),
            kind,
            systemReason,
            epId: ctx.endPoint.userId,
            isPrivate: ctx.isPrivate,
        });
    }

    /** 取出并清空挂起队列 */
    drainPending(): PendingMessage[] {
        const pending = this.pendingQueue;
        this.pendingQueue = [];
        return pending;
    }

    /** 把挂起队列全部写入上下文（此时上一轮工具回调已入库，位置合法）并保存；返回是否存在触发类消息 */
    async flushPending(): Promise<boolean> {
        const pending = this.drainPending();
        if (pending.length === 0) return false;
        let hasTrigger = false;
        for (const p of pending) {
            if (p.kind === 'trigger') hasTrigger = true;
            await this.context.addUserMessage(p.ctx, p.content, p.userId, p.messageId);
            if (p.systemReason) await this.context.addSystemUserMessage(p.systemReason, '触发原因提示');
        }
        this.save();
        this.clearPending();
        return hasTrigger;
    }

    async reply(ctx: seal.MsgContext, msg: seal.Message, contextArray: string[], replyArray: string[], _images: Image[], options: { withSegmentDelay?: boolean } = {}, reasoningContent?: string) {
        const { withSegmentDelay = false } = options;
        const { SEGMENT_DELAY_ENABLED, SEGMENT_DELAY_MS, SEGMENT_IMAGE_EXTRA_DELAY_MS } = Config.reply;

        for (let i = 0; i < contextArray.length; i++) {
            const content = contextArray[i];
            const reply = replyArray[i];

            // 分段发送延时（流式/非流式共用）：从第二条起，发送前等待配置的毫秒数，防止乱序
            if (withSegmentDelay && SEGMENT_DELAY_ENABLED && i > 0) {
                let delayMs = Math.max(0, SEGMENT_DELAY_MS);
                if (/\[CQ:image(?:,[^\]]*)?\]/.test(reply)) {
                    delayMs += Math.max(0, SEGMENT_IMAGE_EXTRA_DELAY_MS);
                }
                if (delayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }

            const msgId = await replyToSender(ctx, msg, this, reply);
            await this.context.addAssistantMessage(content, msgId, reasoningContent);
        }

    }

    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = '', tool_choice?: string): Promise<void> {
        this.lastCtx = ctx;
        log.info('trigger reply:', reason || 'unknown');

        // 4.14.0：首次对话时把历史 <|...|> 渲染标签迁移为新格式 [xxx]（幂等，后续对话无旧标签可迁）
        this.migrateStoredTags();

        if (reason !== '函数回调触发') {
            const { BUCKET_LIMIT, FILL_INTERVAL } = Config.trigger;
            if (Date.now() - this.bucket.lastTime > FILL_INTERVAL * 1000) {
                const fillCount = (Date.now() - this.bucket.lastTime) / (FILL_INTERVAL * 1000);
                this.bucket.count = Math.min(this.bucket.count + fillCount, BUCKET_LIMIT);
                this.bucket.lastTime = Date.now();
            }
            if (this.bucket.count <= 0) {
                log.warning('bucket empty, skip reply');
                return;
            }
        }

        const { BLOCKED } = Config.tool;
        BLOCKED.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(this.tool.state, key)) this.tool.state[key] = false;
        });

        this.resetState();
        this.bucket.count--;

        // 评分触发：无论以何种方式触发会话，都起一轮 WAIT 作为冷却（不扣精力）；轮内新消息挂起、轮末重新过 gate
        JudgeManager.noteSessionTrigger(ctx, this, reason || 'unknown');

        const model = Model.getChatModel('chat', this.setting.modelName);
        if (model && model.provider === 'anthropic' && (model.body as any).stream === true) {
            log.warning(`anthropic 提供商（${model.name}）暂不支持流式输出，已自动切换为非流式`);
        }
        if (model && (model.body as any).stream === true && model.provider !== 'anthropic') {
            await this.chatStream(ctx, msg);
            this.save();
            return;
        }

        // 对话与工具调用编排统一由智能体 run() 处理（构建消息 → 模型 → 工具执行 → 回填 → 最终回复）
        await this.agent.run(this, ctx, msg, tool_choice);
        this.save();
    }

    async chatStream(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        this.lastCtx = ctx;
        // 4.14.0：首次对话时把历史 <|...|> 渲染标签迁移为新格式 [xxx]（幂等）
        this.migrateStoredTags();
        // 流式编排统一由智能体 runStream() 处理
        await this.agent.runStream(this, ctx, msg);
    }

    /** 迁移本会话上下文/记忆与全局记忆中的历史 <|...|> 标签为新格式 [xxx]（幂等） */
    migrateStoredTags() {
        for (const m of this.context.messages) {
            const message = m as any;
            if (Array.isArray(message.contentItems)) {
                message.contentItems.forEach((item: any) => {
                    if (item && typeof item.text === 'string') item.text = normalizeRenderTags(item.text);
                });
            }
            if (message.role === 'tool' && typeof message.text === 'string') {
                message.text = normalizeRenderTags(message.text);
            }
            const toolCalls = message.toolCalls || message.tool_calls;
            if (Array.isArray(toolCalls)) {
                toolCalls.forEach((tc: any) => {
                    if (tc && tc.function && typeof tc.function.arguments === 'string') {
                        tc.function.arguments = normalizeRenderTags(tc.function.arguments);
                    }
                });
            }
        }
        this.memory?.migrateLegacyTags();
    }

    async stopCurrentChatStream(): Promise<void> {
        const { id, reply, toolCallStatus } = this.stream;
        this.stream = {
            id: '',
            reply: '',
            toolCallStatus: false
        }
        if (id) {
            log.info('end stream:', id);
            if (reply && toolCallStatus) log.warning('unfinished tool call:', reply);
            await streamService.endStream(id);
        }
    }

    /** 完全停止本会话对话：结束流式输出、升级 stopVersion 中止运行中循环、清理该会话排队请求、清待触发计时器；
     *  AI 设定触发条件保留（需主动触发）。返回各项是否发生，供命令反馈。 */
    async stopConversation(): Promise<{ hadStream: boolean; hadRun: boolean; hadTimer: boolean; queueCleared: number }> {
        const hadStream = this.stream.id !== '';
        const hadRun = this.running;
        const hadTimer = this.context.timer !== null;
        // 先触发停止信号：同步唤醒所有 withTimeout/requestModel 等待者，立即中断进行中的模型请求与工具链
        // （goja 无法硬中断底层 fetch，但插件侧逻辑会立即以 StopError 退出，不再消费结果/重试/续跑）
        fireStopEvent(this.stopEvent);
        await this.stopCurrentChatStream();
        this.stopVersion++;
        this.starting = false;
        // 归零运行计数与启动标记：stop 后 .ai live 立即显示空闲；运行中循环即使被唤醒也因代际变化直接返回
        this.activeRuns = 0;
        this.running = false;
        // 完全暂停：清掉挂起消息（停止后不复活）与待触发的计时器（计数器/概率/触发条件保留，需主动触发）
        this.pendingQueue = [];
        this.clearPending();
        if (this.context.timer) clearTimeout(this.context.timer);
        this.context.timer = null;
        // 评分触发：停止会话时清掉 WAIT 轮末定时器与内存状态
        JudgeManager.clearSession(this.sessionId);
        const queueCleared = requestLimiter.cancelBySession(this.sessionId);
        this.save();
        log.info(`stop conversation: stream=${hadStream} running=${hadRun} timer=${hadTimer} queueCleared=${queueCleared}`);
        return { hadStream, hadRun, hadTimer, queueCleared };
    }

}
