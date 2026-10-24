// 会话上下文：消息增删/忽略名单/压缩与总结触发/按 ID 获取目标/图片查找
import type Agent from "../agent/agent";
import Config from "../config/config";
import { getAgent } from "../core/ports/agent_registry";
import { getAuxLlm } from "../core/ports/aux_llm";
import Logger from "../logger";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import User from "../session/user";
import { ToolCall, ToolContentPart } from "../tool/types";
import { buildToolTruncateMarker, buildUserBlockMarker, buildUserSingleMarker, buildUserTruncateMarker, stripRawMarkers } from "../utils/raw_marker";
import { TypeDescriptor } from "../utils/revive";
import { stripInternalTags } from "../utils/string";

import { archiveByTokenIfNeeded as archiveByTokenIfNeededImpl, settleWindowIfNeeded as settleWindowIfNeededImpl, trimToWindow as trimToWindowImpl } from "./archiver";
import { parseText } from "./content/text_parse";
import { normalizeToolResult } from "./content/tool_result";
import type { Part } from "./events";
import Message from "./message";
import { canMirror, mirrorAssistant, mirrorServiceFor, mirrorSystem, mirrorToolCalls, MirrorToolGroups, mirrorToolResult, mirrorUser } from "./mirror";
import { editEventParts } from "./mutations";
import { buildProjection } from "./projection";
import { findImage as findImageOf, getGroupById as getGroupByIdOf, getUserById as getUserByIdOf, setName as setNameOf, updateName as updateNameOf, userInfoList as userInfoListOf } from "./roster";
import { runtimeOf } from "./runtime";
import type { ContextService } from "./service";
import { AssistantMessage, AssistantMessageItem, MessageType, SystemUserMessageItem, ToolCallbackMessage, ToolCallsMessage, UserMessage, UserMessageItem } from "./types";
import { truncateMiddle } from "./window_policy";

// 兼容旧引用：归档分块预算已拆到 ./archiver（内部实现请直接引用叶子）
export { ARCHIVE_CHUNK_TOKENS } from "./archiver";
// 兼容旧引用：窗口策略纯函数已拆到 ./window_policy（内部实现请直接引用叶子）
export { buildRoundSegments, dropOldestRound, estimateContextMessagesTokens, getKeepStart, isRealUserMessage, splitMessagesByToken, truncateMiddle } from "./window_policy";

const log = Logger.withTag('context');

/** 镜像用的工具调用配对表：只存在于运行时，不进入持久化字段 */
const mirrorGroups = new WeakMap<object, MirrorToolGroups>();

function mirrorGroupsOf(context: object): MirrorToolGroups {
    let groups = mirrorGroups.get(context);
    if (!groups) {
        groups = new MirrorToolGroups();
        mirrorGroups.set(context, groups);
    }
    return groups;
}

/** 群内用户会话的记忆权重（accessCount/lastAccessedAt）节流持久化：每会话 5 分钟内最多写一次，
// 避免每条消息都对所有历史发言者全量序列化。当前会话由对话收尾统一保存。 */
const lastUserMemorySaveAt: { [sessionId: string]: number } = {};
const USER_MEMORY_SAVE_INTERVAL_MS = 5 * 60 * 1000;

/** 待机入库配额计数（P2-2）：模块级 WeakMap，按"小时桶"计数，不持久化 */
const coldQuota = new WeakMap<object, { hour: number; count: number }>();

function flushGroupUserMemories(session: Session): void {
    if (session.sessionType !== 'group') return;
    const now = Date.now();
    const agent = session.agent;
    for (const uid of session.context.users) {
        const us = agent.sessionService.getSession(uid);
        const last = lastUserMemorySaveAt[uid] || 0;
        if (now - last > USER_MEMORY_SAVE_INTERVAL_MS) {
            us.save();
            // 保存成功后再记录时间，避免保存失败仍被节流跳过
            lastUserMemorySaveAt[uid] = now;
        }
    }
}

/** 上下文条目定位引用：addSystemUserMessageTracked 的返回值，供事件去重"后到覆盖先到"就地替换 */
export interface SystemEntryRef {
    messageIndex: number;
    itemIndex: number;
    /** Context v2：被追踪事件的 seq（用于后续 EditRecord 替换） */
    seq?: number;
}

export class Context {
    static validKeysMap: { [key in keyof Context]?: TypeDescriptor<Context[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        messages: { array: 'any' },
        ignoreList: { array: 'string' },
        autoNameMod: 'number',
    }
    agentName: string;
    sessionId: string;
    /** 旧数据模型（仅在未接入 v2 时使用；接入后由 v2 projection 派生） */
    private legacyMessages: MessageType[] = [];
    private v2Service: ContextService | null = null;
    private v2Projection: MessageType[] | null = null;
    ignoreList: string[];
    lastReply: string;
    counter: number;
    timer: number | null;
    autoNameMod: number;

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.messages = [];
        this.ignoreList = [];
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
        this.autoNameMod = 0;
    }

    /**
     * 消息视图：接入 v2 后由 projection 派生（过渡期可变缓存，供旧消费者读；写以 v2 为准）；
     * 未接入时使用旧数组（迁移前/单测旧路径）。
     */
    get messages(): MessageType[] {
        if (!this.v2Service) return this.legacyMessages;
        if (!this.v2Projection) {
            this.v2Projection = buildProjection(this.v2Service.snapshot(), {
                maxUnits: 200,
                maxChars: 200_000,
                freeze: false,
            });
        }
        return this.v2Projection;
    }

    set messages(value: MessageType[]) {
        this.legacyMessages = value;
        this.v2Projection = null;
    }

    /** 由 SessionService 在迁移/打开后调用：此后写入/读取走 v2 */
    initV2(service: ContextService | null): void {
        this.v2Service = service;
        this.v2Projection = null;
    }

    get v2Enabled(): boolean {
        return !!this.v2Service;
    }

    private invalidateV2(): void {
        this.v2Projection = null;
    }

    private flushV2(): void {
        const service = this.v2Service;
        if (!service) return;
        void service.flush().then(result => {
            if (!result.ok) log.warning('Context v2 落盘失败: ' + (result.error ?? 'unknown'));
        }).catch(error => log.warning('Context v2 落盘异常: ' + (error instanceof Error ? error.message : String(error))));
    }

    private appendV2User(text: string, userId: string, messageId: string): void {
        const service = this.v2Service;
        if (!service) return;
        service.appendUser(userId, messageId, parseText(stripInternalTags(text), 'user'));
        this.invalidateV2();
        this.flushV2();
    }

    private appendV2Assistant(text: string, messageId: string, reasoningContent?: string): void {
        const service = this.v2Service;
        if (!service) return;
        service.appendAssistant(messageId, parseText(stripInternalTags(text), 'model-output'), {
            ...(reasoningContent !== undefined ? { reasoning: reasoningContent } : {}),
        });
        this.invalidateV2();
        this.flushV2();
    }

    private appendV2System(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): number | null {
        const service = this.v2Service;
        if (!service) return null;
        const seqs = service.appendSystem({
            systemName,
            eventType: extra?.eventType,
            raw: extra?.raw,
            parts: parseText(stripInternalTags(text), 'internal'),
        });
        this.invalidateV2();
        this.flushV2();
        return seqs[0] ?? null;
    }

    get agent(): Agent { return getAgent(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }
    get users(): string[] {
        const userSet = new Set<string>();
        for (const m of this.messages) {
            if (Message.getMessageType(m) !== 'user') continue;
            for (const umi of (m as UserMessage).contentItems) {
                if (Message.getUserMessageItemType(umi) !== 'user') continue;
                userSet.add((umi as UserMessageItem).userId);
            }

        }
        return Array.from(userSet);
    }

    clearMessages(...roles: Array<'user' | 'assistant' | 'tool'>) {
        if (this.v2Service) {
            // v2 的唯一删除路径是显式 purge/hide；这里不静默物理删除
            log.warning('Context v2 已启用：clearMessages 不再直接删消息，请使用 .ai ctx hide/purge');
            return;
        }
        if (roles.length === 0) {
            this.messages = [];
            return;
        }

        this.messages = this.messages.filter(m => !roles.includes(m.role as any));
    }

    reviveMessages() {
        this.messages = this.messages.map(m => {
            if (!m || typeof m.role !== 'string') return null;
            if (Array.isArray((m as any).contentItems)) {
                (m as any).contentItems = (m as any).contentItems.filter((i: any) => i && typeof i.text === 'string');
            }
            // 清理历史遗留的空 tool_calls（如旧版本异常写入的 []），避免空数组进入请求体
            if ((m as any).role === 'assistant') {
                const toolCalls = (m as any).toolCalls || (m as any).tool_calls;
                if (Array.isArray(toolCalls) && toolCalls.length === 0) {
                    delete (m as any).toolCalls;
                    delete (m as any).tool_calls;
                }
            }
            return m;
        }).filter(m => m !== null);
    }

    /**
     * 文本超过压缩阈值时交给压缩智能体，返回 {display, original, changed, called}。
     * 采纳条件（docs/03 上下文模块）：结果必须**比原文更短**，否则保留原文（不更短就不采纳）；
     * `called` 表示这次是否真的调用了压缩智能体（未超阈值时为 false，供账本计数用）。
     */
    static async compressPreserveIfLong(text: string): Promise<{ display: string; original: string; changed: boolean; called: boolean }> {
        const { COMPRESS_THRESHOLD } = Config.context;
        if (text.length <= COMPRESS_THRESHOLD) return { display: text, original: text, changed: false, called: false };
        try {
            const compressed = await getAuxLlm().chat('compress_agent', text);
            if (compressed && compressed !== text && compressed.length < text.length) {
                return { display: compressed, original: text, changed: true, called: true };
            }
            if (compressed && compressed.length >= text.length) {
                log.info(`[ctx-cost] 压缩结果未变短（原 ${text.length} 字 → ${compressed.length} 字），保留原文`);
            }
        } catch (e) {
            log.warning('压缩消息失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
        }
        return { display: text, original: text, changed: false, called: true };
    }

    /** 冷态判定：待机（会话或全局）且无在途对话。游离 Context / 测试桩没有 stateOf 时按热态处理，保持原行为 */
    private isColdSession(): boolean {
        const s: any = this.session;
        if (!s || typeof s.stateOf !== 'function') return false;
        return s.stateOf() === 'COLD';
    }

    /** 本会话账本计数（游离/桩会话没有 ctxStats 时忽略） */
    private bumpStat(key: 'compression' | 'summarization' | 'judge'): void {
        const s: any = this.session;
        if (s && s.ctxStats && typeof s.ctxStats[key] === 'number') s.ctxStats[key] += 1;
    }

    /**
     * 待机入库配额（P2-2）：本会话**每小时**最多入库 `待机入库配额` 条普通群消息（0=不限制）。
     * 计数放模块级 WeakMap（运行时状态，不持久化）——重载后重置等价于"新的一小时"，是安全的放宽。
     * @returns 是否允许本次入库
     */
    private allowColdIngest(): boolean {
        const quota = Config.context.STANDBY_INGEST_QUOTA;
        if (quota <= 0) return true;
        const hour = Math.floor(Date.now() / 3600000);   // 整点分桶
        let q = coldQuota.get(this);
        if (!q || q.hour !== hour) {
            q = { hour, count: 0 };
            coldQuota.set(this, q);
        }
        q.count++;
        if (q.count > quota) return false;
        return true;
    }

    /**
     * 冷态入库条目：**零 LLM** —— 只做纯代码截断（留头留尾），原文进 rawText 并带"原文已截断"标记。
     * 标记 compressed=true 表示"永不参与 LLM 压缩"（冷态诞生的内容转热后也不会被回溯压缩）。
     */
    private buildColdUserItem(text: string, userId: string, messageId: string): UserMessageItem {
        // 按会话覆盖优先（P2-1）
        const s: any = this.session;
        const COLD_SINGLE_TRUNCATE = s?.setting?.overrideOr?.('coldTruncate', Config.context.COLD_SINGLE_TRUNCATE)
            ?? Config.context.COLD_SINGLE_TRUNCATE;
        const original = stripInternalTags(text);
        const item: UserMessageItem = {
            text: original,
            time: Math.floor(Date.now() / 1000),
            userId,
            messageId,
            compressed: true,
        };
        if (COLD_SINGLE_TRUNCATE > 0 && original.length > COLD_SINGLE_TRUNCATE) {
            const shown = truncateMiddle(original, COLD_SINGLE_TRUNCATE);
            item.text = shown + buildUserTruncateMarker(original.length, shown.length, messageId);
            item.rawText = original;
        }
        return item;
    }

    /** 追加用户条目：延续"连续 user 消息并入同一条消息"的现有语义 */
    private appendUserItem(item: UserMessageItem): void {
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) {
            (lastMessage as UserMessage).contentItems.push(item);
        } else {
            this.messages.push({ role: 'user', contentItems: [item] });
        }
    }

    /**
     * 合并压缩块内**尚未尝试过压缩的尾部连续条目**（已尝试过的一律不再进入压缩输入）。
     * - 采纳：这批条目替换为一条块条目（rawItems 保留原文），块条目 compressed=true；
     * - 未采纳/失败：把这批条目标记为已尝试，避免下一条消息到来时再次付费重压。
     *
     * 注意：必须取"**尾部连续**未压缩段"（从末尾向前扫到第一个已压缩条目为止），不能用
     * `filter(it => !it.compressed)` —— 单条压缩成功的条目会带 compressed 夹在中间，过滤会把
     * 夹在其前后的旧条目合并后搬到末尾，打乱消息时序。
     */
    private async compressPendingTail(userMsg: UserMessage): Promise<void> {
        const items = userMsg.contentItems as UserMessageItem[];
        let start = items.length;
        while (start > 0 && !items[start - 1].compressed) start--;
        const pending = items.slice(start);
        if (pending.length === 0) return;
        // 尾部若全是系统条目（事件/提示，没有 userId），不做压缩：没有群聊原文值得付这笔钱
        if (!pending.some(it => it.userId)) return;

        const joined = pending.map(it => stripRawMarkers(it.rawText ?? it.text)).join('\f');
        const block = await Context.compressPreserveIfLong(joined);
        if (block.called) this.bumpStat('compression');
        if (block.changed && block.display !== joined) {
            // 块条目的身份取"最后一条真实用户条目"（系统条目没有 messageId，不能当块 id）
            const last = [...pending].reverse().find(it => it.userId) as UserMessageItem;
            // 系统条目不进块内原文（read_raw 的块目录按 msg_id 寻址，无 userId 的条目会变成 undefined）
            const rawItems = pending
                .filter(it => it.userId)
                .map(it => ({
                    userId: it.userId,
                    messageId: it.messageId,
                    time: it.time,
                    text: stripRawMarkers(it.rawText ?? it.text)
                }));
            let display = stripInternalTags(block.display);
            display += buildUserBlockMarker(pending.length, joined.length, last.messageId);
            userMsg.contentItems = [
                ...items.slice(0, start),
                {
                    text: display,
                    time: last.time,
                    userId: last.userId,
                    messageId: last.messageId,
                    compressed: true,
                    rawItems
                }
            ];
        } else if (block.called) {
            // 真的调用过压缩但未采纳/失败：标记为已尝试，避免下一条消息到来时再次付费重压
            for (const it of pending) it.compressed = true;
        }
        // called=false（合计未超阈值）：不标记，留待后续消息累积后再合并
    }

    /**
     * 用户消息入库（串行化入口）：压缩段是异步的，两条消息并发时会在 await 期间互相覆盖
     * `contentItems`（后完成者用旧快照重建，可能丢掉中间追加的条目）。这里用每会话的
     * promise 链把入库串行化——运行时状态放模块级 WeakMap，不污染持久化字段。
     */
    async addUserMessage(ctx: seal.MsgContext, text: string, userId: string, messageId: string): Promise<void> {
        if (this.v2Service) {
            this.appendV2User(text, userId, messageId);
            return;
        }
        const rt = runtimeOf(this);
        const run = rt.ingestChain.then(() => this.addUserMessageInner(ctx, text, userId, messageId));
        rt.ingestChain = run.then(() => undefined, () => undefined);   // 前一次失败不阻塞后续入库
        return run;
    }

    // ---------------- Context v2 受控镜像（默认关闭） ----------------
    private mirrorTarget(): import("./service").ContextService | null {
        return canMirror(this) ? mirrorServiceFor(this) : null;
    }

    private flushMirror(service: import("./service").ContextService): void {
        void service.flush().then(result => {
            if (!result.ok) log.warning('Context v2 镜像落盘失败: ' + (result.error ?? 'unknown'));
        }).catch(e => log.warning('Context v2 镜像落盘异常: ' + (e instanceof Error ? e.message : String(e))));
    }

    private mirrorUserToV2(text: string, userId: string, messageId: string): void {
        const service = this.mirrorTarget();
        if (!service) return;
        try {
            mirrorUser(service, { uid: userId, msgId: messageId, text });
            this.flushMirror(service);
        } catch (e) {
            log.warning('Context v2 镜像用户消息失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    private mirrorAssistantToV2(text: string, messageId: string, reasoningContent?: string): void {
        const service = this.mirrorTarget();
        if (!service) return;
        try {
            mirrorAssistant(service, { msgId: messageId, text, reasoning: reasoningContent });
            this.flushMirror(service);
        } catch (e) {
            log.warning('Context v2 镜像助手消息失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    private mirrorSystemToV2(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): void {
        const service = this.mirrorTarget();
        if (!service) return;
        try {
            mirrorSystem(service, { text, systemName, eventType: extra?.eventType, raw: extra?.raw });
            this.flushMirror(service);
        } catch (e) {
            log.warning('Context v2 镜像系统消息失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    private mirrorToolCallsToV2(toolCalls: ToolCall[], reasoningContent?: string): void {
        const service = this.mirrorTarget();
        if (!service) return;
        try {
            const groups = mirrorGroupsOf(this);
            const turnId = groups.nextTurnId();
            const mapping = mirrorToolCalls(service, { toolCalls, reasoning: reasoningContent, turnId });
            groups.register(mapping);
            this.flushMirror(service);
        } catch (e) {
            log.warning('Context v2 镜像工具调用失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    private mirrorToolResultToV2(text: string, toolCallId: string, toolName?: string, contentParts?: ToolContentPart[]): void {
        const service = this.mirrorTarget();
        if (!service) return;
        try {
            const groups = mirrorGroupsOf(this);
            mirrorToolResult(service, {
                callId: toolCallId,
                toolName,
                text,
                contentParts,
                group: groups.get(toolCallId),
            });
            this.flushMirror(service);
        } catch (e) {
            log.warning('Context v2 镜像工具结果失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    // 用户消息入库：热态下"单条超长 / 连续多条合并后超阈值"交给压缩智能体；冷态（待机）只做纯代码截断。
    // 压缩前原文保留在条目 rawText/rawItems（不参与渲染与 token 估算），展示文本末尾带标记，
    // AI 可用 read_raw/grep_raw(kind=user) 按 msg_id（单条）/ blk:<末条messageId>（合并块）核对原文
    private async addUserMessageInner(ctx: seal.MsgContext, text: string, userId: string, messageId: string) {
        // 自动改名：按 autoNameMod 设置，在用户首次出现时更新上下文中的名字
        if (this.autoNameMod > 0) {
            try {
                await this.updateName(ctx.endPoint.userId, ctx.group ? ctx.group.groupId : '', userId);
            } catch (e) {
                log.warning('自动改名失败: ' + (e instanceof Error ? e.message : String(e)));
            }
        }

        // 冷态（待机且无在途对话）：入库零 LLM —— 只追加 + 纯代码截断，不调用压缩智能体、不做合并压缩
        if (this.isColdSession()) {
            // 待机入库配额（P2-2）：极端灌水群防滥用。超出后只计数不入库（不报错、不回复）。
            if (!this.allowColdIngest()) return;
            this.appendUserItem(this.buildColdUserItem(text, userId, messageId));
            this.mirrorUserToV2(text, userId, messageId);
            // L1 窗口移出（P1-2）：纯代码、零 LLM，让 session 体积有上界。必须在入库之后做，
            // 且**不能**因为移出失败而影响入库本身（尽力而为）。
            try { this.trimToWindow(); } catch (e) {
                log.warning('窗口移出失败（不影响入库）: ' + (e instanceof Error ? e.message : String(e)));
            }
            flushGroupUserMemories(this.session);
            return;
        }

        // —— 热态：单条压缩（超阈值即视为"已尝试过"，含未采纳/失败，避免反复付费） ——
        const single = await Context.compressPreserveIfLong(text);
        if (single.called) this.bumpStat('compression');
        let itemText = stripInternalTags(single.display);
        const rawText = single.changed ? stripInternalTags(single.original) : undefined;
        if (rawText !== undefined) {
            // 防注入：压缩智能体可能回带标签，入库前再兜底剥离一次（主入口在 transformArrayToContent）
            itemText = stripInternalTags(itemText);
            itemText += buildUserSingleMarker(single.original.length, itemText.length, messageId);
        }
        const umi: UserMessageItem = {
            text: itemText,
            time: Math.floor(Date.now() / 1000),
            userId,
            messageId,
            // 真的调用过压缩（含未采纳/失败）才标记"已尝试"，避免反复付费；未超阈值时不标记，留待后续合并
            ...(single.called ? { compressed: true } : {}),
            ...(rawText !== undefined ? { rawText } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) {
            const userMsg = lastMessage as UserMessage;
            userMsg.contentItems.push(umi);
            // 连续多条 user 消息合并后总长超阈值 → 合并压缩（只压未尝试过的尾部，见 compressPendingTail）
            await this.compressPendingTail(userMsg);
        } else {
            this.messages.push({
                role: 'user',
                contentItems: [umi]
            });
        }
        this.mirrorUserToV2(text, userId, messageId);
        // 群内用户会话的权重更新节流持久化（避免每条消息全量写盘）
        flushGroupUserMemories(this.session);
    }

    addAssistantMessage(text: string, messageId: string, reasoningContent?: string) {
        if (this.v2Service) {
            this.appendV2Assistant(text, messageId, reasoningContent);
            return;
        }
        // 防泄露：兜底剥离内部上下文标签（正常回复在 handleReply 已剥离）
        text = stripInternalTags(text);
        const ami: AssistantMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            messageId,
            ...(reasoningContent !== undefined ? { reasoningContent } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'assistant' && Array.isArray((lastMessage as AssistantMessage).contentItems)) (lastMessage as AssistantMessage).contentItems.push(ami);
        else this.messages.push({
            role: 'assistant',
            contentItems: [ami]
        });
        this.mirrorAssistantToV2(text, messageId, reasoningContent);
        flushGroupUserMemories(this.session);
        // 不再按轮数周期观察：上下文 token 超限后统一由 archiveByTokenIfNeeded 异步归档
        void this.archiveByTokenIfNeeded().catch(e => {
            log.warning('上下文归档失败: ' + (e instanceof Error ? e.message : String(e)));
        });
    }

    addSystemUserMessage(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }) {
        if (this.v2Service) {
            this.appendV2System(text, systemName, extra);
            return;
        }
        text = stripInternalTags(text);
        const sumi: SystemUserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            systemName,
            ...(extra?.eventType ? { eventType: extra.eventType } : {}),
            ...(extra?.raw !== undefined ? { raw: extra.raw } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) (lastMessage as UserMessage).contentItems.push(sumi);
        else this.messages.push({
            role: 'user',
            contentItems: [sumi]
        });
        this.mirrorSystemToV2(text, systemName, extra);
    }

    /** 追加系统用户消息并返回条目定位引用（供事件去重窗口内"后到覆盖先到"的就地替换使用）。与 addSystemUserMessage 同构。 */
    addSystemUserMessageTracked(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): SystemEntryRef | null {
        if (this.v2Service) {
            const seq = this.appendV2System(text, systemName, extra);
            return seq === null ? null : { messageIndex: -1, itemIndex: -1, seq };
        }
        text = stripInternalTags(text);
        const sumi: SystemUserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            systemName,
            ...(extra?.eventType ? { eventType: extra.eventType } : {}),
            ...(extra?.raw !== undefined ? { raw: extra.raw } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        let messageIndex: number;
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) {
            messageIndex = this.messages.length - 1;
            (lastMessage as UserMessage).contentItems.push(sumi);
        } else {
            messageIndex = this.messages.length;
            this.messages.push({ role: 'user', contentItems: [sumi] });
        }
        const container = (this.messages[messageIndex] as UserMessage).contentItems;
        this.mirrorSystemToV2(text, systemName, extra);
        return { messageIndex, itemIndex: container.length - 1 };
    }

    /**
     * 按引用就地替换系统用户消息条目：事件去重命中时把已入库的旧副本更新为"最后到达的事件"，
     * 保证同一去重窗口内上下文只保留一条、内容取最新。条目已被合并压缩/归档等改写导致引用
     * 失效时返回 false，由调用方自行兜底（如追加新副本）。
     */
    replaceSystemUserMessage(ref: SystemEntryRef, text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): boolean {
        if (this.v2Service && ref.seq && ref.seq > 0) {
            const parts = parseText(stripInternalTags(text), 'internal');
            const ok = editEventParts(this.v2Service.getStore(), ref.seq, parts);
            if (ok) {
                this.invalidateV2();
                this.flushV2();
            }
            return ok;
        }
        const m = this.messages[ref.messageIndex];
        if (!m || m.role !== 'user' || !Array.isArray(m.contentItems)) return false;
        const item = m.contentItems[ref.itemIndex];
        // 仅当原位置仍是"系统用户消息"（未被压缩成块/清理/归档改写）时才可安全替换
        if (!item || typeof item.text !== 'string' || !(item as SystemUserMessageItem).systemName) return false;
        const systemItem = item as SystemUserMessageItem;
        systemItem.text = stripInternalTags(text);
        systemItem.systemName = systemName;
        if (extra?.eventType) systemItem.eventType = extra.eventType;
        else delete systemItem.eventType;
        if (extra?.raw !== undefined) systemItem.raw = extra.raw;
        else delete systemItem.raw;
        return true;
    }

    addToolCallsMessage(toolCalls: ToolCall[], reasoningContent?: string) {
        // 防御：空数组不应入库，避免后续请求体携带 "tool_calls":[] 被后端拒绝
        if (!toolCalls || toolCalls.length === 0) {
            log.warning('addToolCallsMessage 收到空数组，已忽略');
            return;
        }
        if (this.v2Service) {
            const groups = mirrorGroupsOf(this);
            const mapping = mirrorToolCalls(this.v2Service, {
                toolCalls,
                reasoning: reasoningContent,
                turnId: groups.nextTurnId(),
            });
            groups.register(mapping);
            this.invalidateV2();
            this.flushV2();
            return;
        }
        const tcm: ToolCallsMessage = {
            role: 'assistant',
            toolCalls,
            ...(reasoningContent !== undefined ? { reasoningContent } : {})
        }
        this.messages.push(tcm);
        this.mirrorToolCallsToV2(toolCalls, reasoningContent);
    }

    // 工具回调消息：过长的结果不再交给压缩智能体，改为只展示开头 N 字（head 截断），
    // 完整原文以 rawText 保留（不参与渲染/预算），供 read_raw/grep_raw(kind=tool) 按 tool_call_id 按需读取。
    async addToolCallbackMessage(text: string, toolCallId: string, toolName?: string, contentParts?: ToolContentPart[]) {
        if (this.v2Service) {
            let parts: Part[] = [];
            try {
                parts = normalizeToolResult({ text, contentParts }, { allowImageRefs: true, noteUnregisteredMedia: false });
            } catch {
                parts = [];
            }
            if (parts.length === 0 && text) parts = [{ type: 'text', text }];
            const groups = mirrorGroupsOf(this);
            const group = groups.get(toolCallId);
            this.v2Service.appendToolResult({
                turnId: group?.turnId ?? `orphan:${toolCallId}`,
                groupId: group?.groupId ?? `orphan:${toolCallId}`,
                callId: toolCallId,
                name: toolName,
                parts,
            });
            this.invalidateV2();
            this.flushV2();
            return;
        }
        const { TOOL_RESPONSE_TRUNCATE_CHARS } = Config.tool;
        // use_skill 自己已做 12000 字符分页，且「续读 offset」在结果末尾：
        // 再套通用 head 截断会把续读提示一起截掉，导致模型无法续读，故豁免。
        // 直接调用（toolName=use_skill）与 call_tool 包装（工具 use_skill 返回：…）都要识别。
        // 内容长度上限仍由 use_skill 的 MAX_SKILL_CONTENT_LENGTH 保证。
        const skipTruncate = toolName === 'use_skill'
            || /^## 技能：/.test(text)
            || /^工具 use_skill 返回：\n/.test(text);
        // 截断前原文：仅当文本确实被截断后保留，供只读工具按需读取（不参与渲染/预算）
        let rawText: string | undefined;
        if (!skipTruncate && TOOL_RESPONSE_TRUNCATE_CHARS > 0 && text.length > TOOL_RESPONSE_TRUNCATE_CHARS) {
            rawText = text;
            text = text.slice(0, TOOL_RESPONSE_TRUNCATE_CHARS);
        }
        // 防注入：工具返回内容（如历史消息、网页文本）中的内部上下文标签直接剥离，不进入上下文
        text = stripInternalTags(text);
        if (rawText !== undefined) {
            // 原文与展示文本走同一防注入处理；附加指针提示让模型知道内容被截断、可以按需翻原文
            rawText = stripInternalTags(rawText);
            text += buildToolTruncateMarker(rawText.length, text.length, toolCallId);
        }
        const tcbm: ToolCallbackMessage = {
            role: 'tool',
            text,
            ...(rawText !== undefined ? { rawText } : {}),
            toolCallId,
            contentParts,
            toolName
        }
        this.messages.push(tcbm);
        this.mirrorToolResultToV2(text, toolCallId, toolName, contentParts);
    }

    async settleWindowIfNeeded(now: number = Date.now()): Promise<number> {
        if (this.v2Service) return 0;
        return settleWindowIfNeededImpl(this, now);
    }

    trimToWindow(): number {
        if (this.v2Service) return 0;
        return trimToWindowImpl(this);
    }

    async archiveByTokenIfNeeded(targetTokens?: number): Promise<'converged' | 'busy' | 'failed'> {
        if (this.v2Service) return 'converged';
        return archiveByTokenIfNeededImpl(this, targetTokens);
    }

    getUserById(userId: string | number): User | null {
        return getUserByIdOf(this, userId);
    }
    get userInfoList(): { isPrivate: true, id: string, name: string }[] {
        return userInfoListOf(this);
    }

    async setName(epId: string, gid: string, uid: string, mod: 'nickname' | 'card') {
        await setNameOf(this, epId, gid, uid, mod);
    }
    getGroupById(groupId: string | number): Group | null {
        return getGroupByIdOf(this, groupId);
    }
    async findImage(_ctx: seal.MsgContext, id: string): Promise<Image | null> {
        return findImageOf(this, _ctx, id);
    }

    async updateName(epId: string, gid: string, uid: string) {
        await updateNameOf(this, epId, gid, uid);
    }

}
