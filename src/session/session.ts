// 会话：聊天编排（chat/chatStream/回复/接收）、设定、工具状态与活跃时间
import Agent from "../agent/agent";
import { streamService } from "../agent/stream";
import { ext } from "../config/config";
import Config from "../config/config";
import { Context } from "../context/context";
import { JudgeManager } from "../judge/judge_manager";
import { logger } from "../logger";
import { MediaTaskManager } from "../media/task_queue";
import SessionMemoryService from "../memory/session_memory";
import { isAnthropicMessages } from "../model/api_dialect";
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

/** 保存节流：合并写的最小间隔与批量上限（海豹 storage 为叠加式，重复写会持续占空间；见 docs/14 §5.11） */
export const SAVE_MIN_INTERVAL_MS = 5000;
export const SAVE_BATCH = 20;

/** 冷热状态的两个时间窗（内置常量，见 docs/14 §3） */
export const HOT_HOLD_MS = 180_000;
export const COOL_DOWN_MS = 60_000;

/** 持久化时排除的运行时字段（监听器/运行状态/挂起队列/节流状态等），不写入存储、不参与 revive 恢复 */
export const SESSION_RUNTIME_KEYS = new Set(['lastCtx', 'running', 'starting', 'stopVersion', 'pendingQueue', 'activeRuns', 'stopEvent', 'headless', 'toolRestriction', 'parentSessionId', 'subagentDepth', 'noticeQueue', 'headlessTranscript', 'saveTimer', 'lastSaveAt', 'saveDeferCount', 'lastRelevantAt', 'ctxStats', 'settleBackoffUntil']);

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
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo', 'regexTrigger', 'judge'];
    static validKeysMap: { [key in keyof Setting]?: TypeDescriptor<Setting[key]> } = {
        priv: 'number',
        standby: 'boolean',
        counter: 'number',
        timer: 'number',
        prob: 'number',
        regexTrigger: 'boolean',
        judge: 'boolean',
        activeTimeInfo: { objectValue: 'any' }
    }
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
    regexTrigger: boolean;
    judge: boolean;
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
        archiveSeq: 'number',
        lastArchivedAt: 'number',
        rawSeq: 'number',
        lastRawAt: 'number',
        settledSeq: 'number',
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
        },
        // 技能/知识库的会话级启用开关：仅记录被 .ai skill/.ai kb off 关闭的项，缺省=开启
        skillState: { objectValue: 'boolean' },
        kbState: { objectValue: 'boolean' }
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
    /**
     * 已写入的归档分片数（**持久化**）：归档内容写在 `session_<id>:arc:<seq>` 独立键里（只写一次、不重写），
     * session 只多这一个数字，避免每次归档都重写整份会话存档（见 docs/14 §5.4）。
     */
    archiveSeq = 0;
    /** 最近一次归档时间（秒；持久化，仅审计与 `.ai ctx` 展示用） */
    lastArchivedAt = 0;
    /**
     * 已写入的**窗口移出**分片数（**持久化**）：窗口外原文写在 `session_<id>:raw:<seq>` 独立键里
     * （只写一次、不重写），session 只多这一个数字，使 `session_<id>` 体积与消息总量解耦（docs/17 §2）。
     */
    rawSeq = 0;
    /** 最近一次窗口移出时间（秒；持久化，仅审计与 `.ai ctx` 展示用） */
    lastRawAt = 0;
    /**
     * 已**结算**（summarize 沉淀进记忆）到的分片序号（**持久化**，docs/17 §3）：
     * 结算只处理 `settledSeq+1 .. rawSeq`，天然幂等——同一批分片跑两次不会重复总结。
     */
    settledSeq = 0;
    /** 运行时字段：结算失败退避截止时间戳（ms；不持久化，重载后回 0＝允许立即重试） */
    settleBackoffUntil = 0;
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
    /** 运行时字段（子代理）：headless=true 时 reply() 不发送，文本进 headlessTranscript（不持久化） */
    headless = false;
    /** 运行时字段（子代理）：工具面求交（≈ DSH toolFilter；allow 求交、deny 优先），null=不限制（不持久化） */
    toolRestriction: { allow?: string[]; deny?: string[] } | null = null;
    /** 运行时字段（子代理）：父会话 id（不持久化） */
    parentSessionId = '';
    /** 运行时字段（子代理）：委派深度（主会话=0，逐层+1；不持久化） */
    subagentDepth = 0;
    /**
     * 运行时字段：后台完成通知队列，每轮请求前 flush（不持久化）。
     * `kind` 区分来源：缺省/'subagent' = 子代理结算；'media' = 媒体生成任务完成。
     * 子代理通知会带 `raw: subagent-notice`（父上下文淘汰时清扫对应记录），媒体通知没有生命周期绑定，不带 raw。
     * 媒体通知带 `taskId`：供"是否已被本会话消费"判定（轮末补触发/重复投递拦截）。
     */
    noticeQueue: { text: string; from: string; time: number; kind?: 'subagent' | 'media'; taskId?: string }[] = [];
    /** 运行时字段（子代理）：headless 下 reply() 收集的回复文本（不持久化） */
    headlessTranscript: string[] = [];
    /** 运行时字段：最近一次"相关活动"＝任何一次 session.chat（@/触发/送达/定时任务都走它）；普通消息入库不算（不持久化） */
    lastRelevantAt = 0;
    /** 运行时字段：本会话账本——压缩/归档/评分各调用了多少次（不持久化） */
    ctxStats: { compression: number; summarization: number; judge: number } = { compression: 0, summarization: 0, judge: 0 };
    /** 运行时字段：保存节流状态（不持久化） */
    private lastSaveAt = 0;
    private saveDeferCount = 0;
    private saveTimer: any = null;
    tool: {
        state: ToolState,
        callCount: number, // 单次触发调用函数计数
        listen: ToolListen // 监听调用函数发送的内容
    }
    /** 技能会话级启用开关：false=本会话关闭，缺省/true=开启 */
    skillState: { [name: string]: boolean };
    /** 知识库会话级启用开关（按库 ID）：false=本会话关闭，缺省/true=开启 */
    kbState: { [id: string]: boolean };

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
        this.skillState = {};
        this.kbState = {};
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
        // 子代理工具面求交（≈ DSH toolFilter）：deny 优先，其次 allow 白名单
        const restriction = this.toolRestriction;
        if (restriction) {
            for (const key of Object.keys(state)) {
                if (restriction.deny && restriction.deny.includes(key)) state[key] = false;
                else if (restriction.allow && !restriction.allow.includes(key)) state[key] = false;
            }
        }
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

    /**
     * 保存会话。
     * @param coalesce 合并写：高频入库路径（待机群每条消息/事件）传 true，5 秒或 20 次最多落盘一次，
     *        并安排一次兜底写入保证最后一次变更落地；命令、归档、回复等关键路径用默认的立即写。
     *        海豹 storage 是叠加式存储（写同样的内容也占新空间），因此高频路径必须合并写。
     */
    save(coalesce = false) {
        const now = Date.now();
        if (coalesce) {
            this.saveDeferCount++;
            if (now - this.lastSaveAt < SAVE_MIN_INTERVAL_MS && this.saveDeferCount < SAVE_BATCH) {
                if (!this.saveTimer) {
                    this.saveTimer = setTimeout(() => {
                        this.saveTimer = null;
                        try { this.save(); } catch (e) {
                            log.warning('会话延迟保存失败: ' + (e instanceof Error ? e.message : String(e)));
                        }
                    }, SAVE_MIN_INTERVAL_MS);
                }
                return;
            }
        }
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        ext.storageSet(`session_${this.sessionId}`, JSON.stringify(this, (key, value) => SESSION_RUNTIME_KEYS.has(key) ? undefined : value));
        this.lastSaveAt = now;
        this.saveDeferCount = 0;
    }

    /**
     * 冷热状态：**算出来的**，不持久化（重载后回默认＝回冷态，安全）。
     * - HOT：非待机（正常对话模式）／有在途任务／距上次相关活动 < 热态保持
     * - COOLING：距上次相关活动 ≥ 热态保持且 < 热态保持 + 冷态回落
     * - COLD：再往后（入库零 LLM、窗口按冷态窗口字数折叠）
     * "相关活动"＝任何一次 `session.chat()`（@/触发命中/结果送达/定时任务都走它）；普通群消息入库不算。
     *
     * @param touch 有在途任务时是否刷新 `lastRelevantAt`（默认 true）。
     *   **只读查询（如 `.ai ctx`）必须传 false**：否则命令本身会把会话"续命"成 HOT，
     *   使 COLD 永远无法被观察到（命令副作用）。
     */
    stateOf(now: number = Date.now(), opts?: { touch?: boolean }): 'HOT' | 'COOLING' | 'COLD' {
        const touch = opts?.touch !== false;
        if (!(this.setting.standby || Config.base.GLOBAL_STANDBY)) return 'HOT';
        const busy = this.running || this.starting || this.activeRuns > 0;
        if (busy) {
            if (touch) this.lastRelevantAt = now;   // 在途任务冻结衰减
            return 'HOT';
        }
        const idle = Math.max(0, now - this.lastRelevantAt);   // 防时钟回拨
        if (idle < HOT_HOLD_MS) return 'HOT';
        if (idle < HOT_HOLD_MS + COOL_DOWN_MS) return 'COOLING';
        return 'COLD';
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

    /**
     * 把后台完成通知队列写入上下文（每轮模型请求前调用，与 flushPending 同点）；返回条数。
     * 两类来源分开口径：媒体生成任务用 `[system:生成任务]`，子代理结算用 `[system:子代理]`
     * 并附 `raw: subagent-notice`（供生命周期清扫识别）。
     */
    async flushNotices(): Promise<number> {
        const queue = this.noticeQueue;
        if (queue.length === 0) return 0;
        this.noticeQueue = [];
        for (const n of queue) {
            if (n.kind === 'media') {
                await this.context.addSystemUserMessage(n.text, '生成任务');
                // 真正呈现给 AI 后才回置 notified：这是"结果已送达、不再需要任何补发"的唯一时机。
                // 放在入队时置位会谎报成功，让重载补发与轮末补触发两条兜底同时失效（原实现的永久等待）。
                if (n.taskId) {
                    try {
                        MediaTaskManager.markNotifiedByNotice(this.sessionId, n.taskId);
                    } catch (e) {
                        log.warning(`媒体任务 #${n.taskId} 回置 notified 失败：${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                continue;
            }
            const tag = n.from && n.from !== '' ? `子代理 ${n.from} ` : '子代理 ';
            // raw 标记：子代理生命周期绑定（父上下文淘汰该 notice 时清扫对应记录）
            await this.context.addSystemUserMessage(tag + n.text, '子代理', {
                raw: { kind: 'subagent-notice', childId: n.from || '' },
            });
        }
        return queue.length;
    }

    async reply(ctx: seal.MsgContext, msg: seal.Message, contextArray: string[], replyArray: string[], _images: Image[], options: { withSegmentDelay?: boolean } = {}, reasoningContent?: string) {
        // headless（子代理）：不向聊天发送，仅把回复写入上下文与 transcript
        if (this.headless) {
            for (let i = 0; i < contextArray.length; i++) {
                const content = contextArray[i];
                const reply = replyArray[i];
                await this.context.addAssistantMessage(content, `sub:${this.headlessTranscript.length}`, reasoningContent);
                if (reply !== undefined && reply.trim() !== '') this.headlessTranscript.push(reply);
            }
            return;
        }
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
        // 回复与助手消息属于"必须落盘"的关键变更（保存节流只作用于高频入库路径）
        this.save();

    }

    /**
     * 起一轮对话。
     * @param options.skipBucket 跳过触发令牌桶（不检查也不扣减）：用于"用户请求的结果送达"这类
     *        非主动搭话的场景（如媒体生成完成唤醒）。注意与旧有的 `reason === '函数回调触发'`
     *        不同：那条豁免只跳过检查、仍会扣减令牌，此处保持原样不动。
     */
    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = '', tool_choice?: string, options: { skipBucket?: boolean } = {}): Promise<void> {
        this.lastCtx = ctx;
        // 冷热状态的"相关活动"：任何一次起一轮对话（@/触发命中/结果送达/定时任务）都算，普通消息入库不算
        this.lastRelevantAt = Date.now();
        log.info('trigger reply:', reason || 'unknown');

        // 4.14.0：首次对话时把历史 <|...|> 渲染标签迁移为新格式 [xxx]（幂等，后续对话无旧标签可迁）
        this.migrateStoredTags();

        const skipBucket = options.skipBucket === true;
        if (reason !== '函数回调触发' && !skipBucket) {
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
        if (!skipBucket) this.bucket.count--;

        // 评分触发：仅当评分触发开启时，无论以何种方式触发会话，都起一轮 WAIT 作为冷却（不扣精力）；
        // 未开启评分时不创建 judgeWait 定时器，避免非指令/其他模式回复也残留评分轮末定时器
        if (this.setting.judge) {
            JudgeManager.noteSessionTrigger(ctx, this, reason || 'unknown');
        }

        const model = Model.getChatModel('chat');
        // 是否流式由「chat 用途」规则模板 body 里的 stream=true 决定（v4：模型不再自带 body，读用途组模板）
        const chatStream = (Model.getBodyDefaultsFor('chat') as any).stream === true;

        const isAnthropic = !!model && isAnthropicMessages(model.api, model.provider);
        if (isAnthropic && chatStream) {
            log.warning(`anthropic-messages 协议（${model!.name}）暂不支持流式输出，已自动切换为非流式`);
        }
        if (model && chatStream && !isAnthropic) {
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
