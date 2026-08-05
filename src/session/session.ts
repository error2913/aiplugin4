// 会话：聊天编排（chat/chatStream/回复/接收）、设定、工具状态与活跃时间
import Agent from "../agent/agent";
import { streamService } from "../agent/stream";
import { ext } from "../config/config";
import Config from "../config/config";
import { Context } from "../context/context";
import { logger } from "../logger";
import SessionMemoryService from "../memory/session_memory";
import Model from "../model/model";
import Image, { ImageManager } from "../resource/image";
import { TimerManager } from "../timer";
import { ToolState } from "../tool/tool";
import { toolMap } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { RequestMessage } from "../utils/message";
import { handleMessages } from "../utils/message";
import { MessageSegment, transformArrayToContent } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";
import { replyToSender, transformMsgId } from "../utils/utils";

import Group from "./group";
import { SessionType, State } from "./types";
import User from "./user";


export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo', 'modelName'];
    static validKeysMap: { [key in keyof Setting]?: TypeDescriptor<Setting[key]> } = {
        priv: 'number',
        standby: 'boolean',
        counter: 'number',
        timer: 'number',
        prob: 'number',
        modelName: 'string',
        activeTimeInfo: { objectValue: 'any' }
    }
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
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
        imageManager: ImageManager,
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
    imageManager: ImageManager;
    stream: {
        id: string,
        reply: string,
        toolCallStatus: boolean
    }
    bucket: {
        count: number,
        lastTime: number
    }
    lastCtx: seal.MsgContext;
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
        this.imageManager = new ImageManager();
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
        this.tool = {
            state: {} as ToolState,
            callCount: 0,
            listen: {
                timeoutId: null,
                resolve: null,
                reject: null,
                cleanup: () => {
                    if (this.tool.listen.timeoutId) clearTimeout(this.tool.listen.timeoutId);
                    this.tool.listen.timeoutId = null;
                    this.tool.listen.resolve = null;
                    this.tool.listen.reject = null;
                }
            }
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
        Object.keys(toolMap).forEach(tool => {
            if (BLOCKED.includes(tool)) return;
            if (!Object.prototype.hasOwnProperty.call(state, tool)) state[tool] = !DEFAULT_CLOSED.includes(tool);
        })
        return state;
    }

    async getMessages(): Promise<RequestMessage[]> {
        if (this.lastCtx) {
            return await handleMessages(this.lastCtx, this);
        }
        return (this.context.messages as any[]).map(m => ({
            role: m.role,
            content: Array.isArray(m.contentItems) ? m.contentItems.map((i: any) => i.text || '').join('\f') : (m.text || '')
        }));
    }

    async getImageMessages(): Promise<RequestMessage[]> {
        return this.getMessages();
    }

    checkIgnoredUserId(userId: string): boolean {
        return this.sessionType === 'group' && Group.get(this.sessionId).ignoredUserIdList.includes(userId);
    }

    get id(): string {
        return this.sessionId;
    }

    resetState() {
        clearTimeout(this.context.timer);
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
        await this.context.addUserMessage(ctx, content, ctx.player.userId, transformMsgId(msg.rawId));
    }

    async reply(ctx: seal.MsgContext, msg: seal.Message, contextArray: string[], replyArray: string[], _images: Image[]) {
        for (let i = 0; i < contextArray.length; i++) {
            const content = contextArray[i];
            const reply = replyArray[i];
            const msgId = await replyToSender(ctx, msg, this, reply);
            await this.context.addAssistantMessage(content, msgId);
        }

        const { P } = Config.image;
        if (P > 0 && Math.random() * 100 <= P) {
            const img = await this.imageManager.drawImage();
            if (img) seal.replyToSender(ctx, msg, img.CQCode);
        }
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = '', tool_choice?: string): Promise<void> {
        this.lastCtx = ctx;
        logger.info('trigger reply:', reason || 'unknown');

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
        if (model && (model.body as any).stream === true) {
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
        // 流式编排统一由智能体 runStream() 处理
        await this.agent.runStream(this, ctx, msg);
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
