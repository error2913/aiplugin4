// 会话：聊天编排（chat/chatStream/回复/接收）、设定、工具状态与活跃时间
import Agent from "../agent/agent";
import { streamService } from "../agent/stream";
import { ext } from "../config/config";
import Config from "../config/config";
import { Context } from "../context/context";
import { logger } from "../logger";
import SessionMemoryService from "../memory/session_memory";
import Model from "../model/model";
import Image from "../resource/image";
import { TimerManager } from "../timer";
import { registerMCPTools } from "../tool/mcp";
import { ToolState } from "../tool/tool";
import { toolMap } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { MessageSegment, normalizeRenderTags, transformArrayToContent } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";
import { getRecordMessageId, replyToSender } from "../utils/utils";

import Group from "./group";
import { createToolListen } from "./tool_listen";
import { SessionType, State } from "./types";
import User from "./user";


export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo', 'modelName', 'regexTrigger'];
    static validKeysMap: { [key in keyof Setting]?: TypeDescriptor<Setting[key]> } = {
        priv: 'number',
        standby: 'boolean',
        counter: 'number',
        timer: 'number',
        prob: 'number',
        regexTrigger: 'boolean',
        modelName: 'string',
        activeTimeInfo: { objectValue: 'any' }
    }
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
    regexTrigger: boolean;
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
        this.bucket.count--;
        this.tool.callCount = 0;
    }

    save() {
        ext.storageSet(`session_${this.sessionId}`, JSON.stringify(this, (key, value) => key === 'lastCtx' ? undefined : value));
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
                else logger.error('active time timer add failed');
            }
        }
    }

    async handleReceipt(ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[]) {
        this.lastCtx = ctx;
        const { content } = await transformArrayToContent(ctx, messageArray);
        await this.context.addUserMessage(ctx, content, ctx.player!.userId, getRecordMessageId(ctx, msg));
    }

    async reply(ctx: seal.MsgContext, msg: seal.Message, contextArray: string[], replyArray: string[], _images: Image[], options: { withSegmentDelay?: boolean } = {}) {
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
            await this.context.addAssistantMessage(content, msgId);
        }

    }

    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = '', tool_choice?: string): Promise<void> {
        this.lastCtx = ctx;
        logger.info('trigger reply:', reason || 'unknown');

        // MCP 工具按配置热加载：同步已新增/移除的服务器工具（内部按 TTL 节流，不阻塞对话）
        registerMCPTools().catch(e => logger.warning('刷新 MCP 工具失败: ' + (e instanceof Error ? e.message : String(e))));

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
                logger.warning('bucket empty, skip reply');
                return;
            }
        }

        const { BLOCKED } = Config.tool;
        BLOCKED.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(this.tool.state, key)) this.tool.state[key] = false;
        });

        this.resetState();

        const model = Model.getChatModel('chat', this.setting.modelName);
        if (model && model.provider === 'anthropic' && (model.body as any).stream === true) {
            logger.warning(`anthropic 提供商（${model.name}）暂不支持流式输出，已自动切换为非流式`);
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
        const globalMemory = Agent.get('*').sessionService.memory;
        if (globalMemory && globalMemory !== this.memory) globalMemory.migrateLegacyTags();
    }

    async stopCurrentChatStream(): Promise<void> {
        const { id, reply, toolCallStatus } = this.stream;
        this.stream = {
            id: '',
            reply: '',
            toolCallStatus: false
        }
        if (id) {
            logger.info('end stream:', id);
            if (reply && toolCallStatus) logger.warning('unfinished tool call:', reply);
            await streamService.endStream(id);
        }
    }
}
