// 会话上下文：消息增删/忽略名单/压缩与总结触发/按 ID 获取目标/图片查找
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { MemoryManager } from "../memory/manager";
import { resolveEffectiveMaxTokens } from "../model/api_error";
import Model from "../model/model";
import { getProbedContextWindow } from "../model/window_cache";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import User from "../session/user";
import { ToolCall, ToolContentPart } from "../tool/types";
import { buildContent, estimateMessageTokens, toolResultCallId } from "../utils/message";
import { callOb11Api } from "../utils/ob11";
import { buildToolTruncateMarker, buildUserBlockMarker, buildUserSingleMarker, buildUserTruncateMarker, stripRawMarkers } from "../utils/raw_marker";
import { stripInternalTags } from "../utils/string";
import { getPlatform, normalizeGroupId, normalizeUserId } from "../utils/target_id";
import { TypeDescriptor, withTimeout } from "../utils/utils";

import { ArchiveShardItem, clearShard, evictExpiredShards, listShardsAsc, writeShardIfAbsent } from "./archive_store";
import Message from "./message";
import { AssistantMessage, AssistantMessageItem, MessageType, SystemUserMessageItem, ToolCallbackMessage, ToolCallsMessage, UserMessage, UserMessageItem } from "./types";

const log = Logger.withTag('context');

/** 群内用户会话的记忆权重（accessCount/lastAccessedAt）节流持久化：每会话 5 分钟内最多写一次，
// 避免每条消息都对所有历史发言者全量序列化。当前会话由对话收尾统一保存。 */
const lastUserMemorySaveAt: { [sessionId: string]: number } = {};
const USER_MEMORY_SAVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 中段截断：保留头 2/3 + 尾 1/3（保留尾部是为了不切断 [img:…] / [record:…] 这类结尾标签）。
 * max ≤ 0 或未超长时原样返回。冷态入库用它做零 LLM 的纯代码截断。
 */
export function truncateMiddle(text: string, max: number): string {
    if (max <= 0 || text.length <= max) return text;
    const head = Math.floor(max * 2 / 3);
    const tail = max - head;
    return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`;
}

/** Context 的运行时状态（放 WeakMap，不进会话存档）：入库串行化链 + 归档连续失败计数 + 结算失败计数 */
interface ContextRuntime { ingestChain: Promise<void>; archiveFailCount: number; settleFailCount?: number }
const contextRuntime = new WeakMap<object, ContextRuntime>();
function runtimeOf(ctx: object): ContextRuntime {
    let rt = contextRuntime.get(ctx);
    if (!rt) {
        rt = { ingestChain: Promise.resolve(), archiveFailCount: 0, settleFailCount: 0 };
        contextRuntime.set(ctx, rt);
    }
    return rt;
}

/** 归档连续失败达到该次数后，允许一次"降级丢弃最早轮次"兜底，避免长会话永久无法回复 */
const ARCHIVE_FAIL_LIMIT = 3;

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

/** 归档分块 token 预算：避免单次总结上下文过大 */
export const ARCHIVE_CHUNK_TOKENS = 50000;

/** 真实用户轮：role=user 且包含真实用户消息项；system-only user 不算轮 */
export function isRealUserMessage(m: MessageType): boolean {
    if (m.role !== 'user') return false;
    if (!Array.isArray((m as UserMessage).contentItems)) return false;
    return (m as UserMessage).contentItems.some(
        item => typeof (item as UserMessageItem).userId === 'string'
    );
}

/** 将消息列表切成“真实 user 轮”段；assistant/tool 不新开轮，system-only 不新开轮 */
export function buildRoundSegments(messages: MessageType[]): Array<{ start: number; end: number }> {
    const segments: Array<{ start: number; end: number }> = [];
    let currentStart: number | null = null;
    let inUserTurn = false;

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.role === 'assistant' || m.role === 'tool') {
            inUserTurn = false;
            continue;
        }

        const realUser = isRealUserMessage(m);

        if (realUser && !inUserTurn) {
            if (currentStart !== null) segments.push({ start: currentStart, end: i });
            currentStart = i;
            inUserTurn = true;
        }
    }

    if (currentStart !== null) segments.push({ start: currentStart, end: messages.length });
    return segments;
}

/** 返回“保留最近 keepRounds 个真实 user 轮”的起始消息下标；不足时返回 0 */
export function getKeepStart(messages: MessageType[], keepRounds: number): number {
    if (keepRounds <= 0) return messages.length;
    const segments = buildRoundSegments(messages);
    if (segments.length <= keepRounds) return 0;
    return segments[segments.length - keepRounds].start;
}

/** 估算 Context 内持久化消息 token 数 */
export function estimateContextMessagesTokens(messages: MessageType[]): number {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m as any), 0);
}

/** 将待归档消息按 token 预算切成连续块，保证每条消息都进入且只进入一个块 */
export function splitMessagesByToken(messages: MessageType[], maxTokens: number): MessageType[][] {
    const chunks: MessageType[][] = [];
    let current: MessageType[] = [];
    let currentTokens = 0;

    for (const m of messages) {
        const t = estimateMessageTokens(m as any);
        if (current.length > 0 && currentTokens + t > maxTokens) {
            chunks.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(m);
        currentTokens += t;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** 丢弃最早的一个真实 user 轮（含其 assistant/tool 消息）；无轮时丢弃最早一条消息 */
export function dropOldestRound(messages: MessageType[]): boolean {
    const segments = buildRoundSegments(messages);
    if (segments.length === 0) {
        if (messages.length === 0) return false;
        messages.splice(0, 1);
        return true;
    }
    const oldest = segments[0];
    messages.splice(oldest.start, oldest.end - oldest.start);
    return true;
}

/** 上下文条目定位引用：addSystemUserMessageTracked 的返回值，供事件去重"后到覆盖先到"就地替换 */
export interface SystemEntryRef {
    messageIndex: number;
    itemIndex: number;
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
    messages: MessageType[];
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

    get agent(): Agent { return Agent.get(this.agentName); }
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
     * 采纳条件（docs/14 §5.3）：结果必须**比原文更短**，否则保留原文（不更短就不采纳）；
     * `called` 表示这次是否真的调用了压缩智能体（未超阈值时为 false，供账本计数用）。
     */
    static async compressPreserveIfLong(text: string): Promise<{ display: string; original: string; changed: boolean; called: boolean }> {
        const { COMPRESS_THRESHOLD } = Config.context;
        if (text.length <= COMPRESS_THRESHOLD) return { display: text, original: text, changed: false, called: false };
        try {
            const compressed = await Agent.get('compress_agent').chat(text);
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
        const rt = runtimeOf(this);
        const run = rt.ingestChain.then(() => this.addUserMessageInner(ctx, text, userId, messageId));
        rt.ingestChain = run.then(() => undefined, () => undefined);   // 前一次失败不阻塞后续入库
        return run;
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
        // 群内用户会话的权重更新节流持久化（避免每条消息全量写盘）
        flushGroupUserMemories(this.session);
    }

    addAssistantMessage(text: string, messageId: string, reasoningContent?: string) {
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
        flushGroupUserMemories(this.session);
        // 不再按轮数周期观察：上下文 token 超限后统一由 archiveByTokenIfNeeded 异步归档
        void this.archiveByTokenIfNeeded().catch(e => {
            log.warning('上下文归档失败: ' + (e instanceof Error ? e.message : String(e)));
        });
    }

    addSystemUserMessage(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }) {
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

    }

    /** 追加系统用户消息并返回条目定位引用（供事件去重窗口内"后到覆盖先到"的就地替换使用）。与 addSystemUserMessage 同构。 */
    addSystemUserMessageTracked(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): SystemEntryRef | null {
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
        return { messageIndex, itemIndex: container.length - 1 };
    }

    /**
     * 按引用就地替换系统用户消息条目：事件去重命中时把已入库的旧副本更新为"最后到达的事件"，
     * 保证同一去重窗口内上下文只保留一条、内容取最新。条目已被合并压缩/归档等改写导致引用
     * 失效时返回 false，由调用方自行兜底（如追加新副本）。
     */
    replaceSystemUserMessage(ref: SystemEntryRef, text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): boolean {
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
        const tcm: ToolCallsMessage = {
            role: 'assistant',
            toolCalls,
            ...(reasoningContent !== undefined ? { reasoningContent } : {})
        }
        this.messages.push(tcm);
    }

    // 工具回调消息：过长的结果不再交给压缩智能体，改为只展示开头 N 字（head 截断），
    // 完整原文以 rawText 保留（不参与渲染/预算），供 read_raw/grep_raw(kind=tool) 按 tool_call_id 按需读取。
    async addToolCallbackMessage(text: string, toolCallId: string, toolName?: string, contentParts?: ToolContentPart[]) {
        const { TOOL_RESPONSE_TRUNCATE_CHARS } = Config.tool;
        // 截断前原文：仅当文本确实被截断后保留，供只读工具按需读取（不参与渲染/预算）
        let rawText: string | undefined;
        if (TOOL_RESPONSE_TRUNCATE_CHARS > 0 && text.length > TOOL_RESPONSE_TRUNCATE_CHARS) {
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
    }

    /**
     * L2 记忆结算（P1-3，docs/17 §3）：把窗口外原文（`raw:`/`arc:` 分片）总结进长期记忆。
     *
     * 为什么需要：记忆沉淀原本只在 `archiveByTokenIfNeeded` 触发，而它的门槛是
     * `上下文最大token`（默认 100 万）→ 实际几乎不触发，待机群历史基本不进长期记忆。
     *
     * **触发（三条件同时成立）**：
     *   ① 待结算积压 ≥ 结算水位；② 上下文总量 ≥ 结算最小门槛；
     *   ③ 距上次相关活动 ≥ 结算空闲门槛，**或** 状态已转入 COLD（转冷时结算一次）。
     *
     * **执行**：从 `raw:` 分片按序号升序读回未结算原文 → `summarizeChunkWithRetry`
     * 抽 facts 写记忆库；成功后推进 `settledSeq` 水位（天然幂等：只处理 `settledSeq+1 .. rawSeq`）。
     *
     * **上限与退避**：单次最多处理 `单次结算调用上限` 个分片；失败按会话指数退避 5/15/60 分钟。
     *
     * @returns 本次实际结算的分片数（0 表示未触发/无积压/失败）
     */
    async settleWindowIfNeeded(now: number = Date.now()): Promise<number> {
        const { SETTLE_WATERMARK, SETTLE_MIN_TOKENS, SETTLE_IDLE_SEC, SETTLE_MAX_SHARDS } = Config.context;
        if (SETTLE_WATERMARK <= 0 || SETTLE_MAX_SHARDS <= 0) return 0;   // 水位 0 = 关闭自动结算
        const s: any = this.session;
        if (!s || !s.sessionId) return 0;

        const rawSeq = typeof s.rawSeq === 'number' ? s.rawSeq : 0;
        const settledSeq = typeof s.settledSeq === 'number' ? s.settledSeq : 0;
        if (rawSeq <= settledSeq) return 0;   // 没有未结算的分片

        // 退避中：直接跳过，不消耗任何调用
        if (typeof s.settleBackoffUntil === 'number' && now < s.settleBackoffUntil) return 0;

        // ① 待结算积压（token）：**必须按"全部未结算分片"计，而不是按本次要处理的那几个**。
        // 反例（真实缺陷，已被 testSettleBacklogAcrossManySmallShards 固化）：积压分散在 50 个小分片里，
        // 总量远超水位，但单次只看前 2 片 → 每片都不够水位 → **永不结算**，历史永远进不了长期记忆。
        // 「单次结算调用上限」限制的是**本次处理几个**，不是"积压怎么算"。
        const allPending = listShardsAsc(s.sessionId, settledSeq + 1, rawSeq, Number.MAX_SAFE_INTEGER, 'raw');
        if (allPending.length === 0) {
            // 分片被清理/读不到：推进水位，避免每次都空转重试
            s.settledSeq = rawSeq;
            return 0;
        }
        const tokensOf = (shards: typeof allPending) => shards.reduce((sum, shard) =>
            sum + shard.items.reduce((n, it) => n + estimateMessageTokens({ role: 'user', contentItems: [{ text: it.text }] } as any), 0), 0);
        if (tokensOf(allPending) < SETTLE_WATERMARK) return 0;

        // 本次实际处理的分片（按序号升序，受单次上限约束）
        const pending = allPending.slice(0, SETTLE_MAX_SHARDS);

        // ② 上下文总量门槛
        if (estimateContextMessagesTokens(this.messages) < SETTLE_MIN_TOKENS) return 0;

        // ③ 空闲门槛 **或** 已转冷
        const state = typeof s.stateOf === 'function' ? s.stateOf(now, { touch: false }) : 'HOT';
        const idleSec = s.lastRelevantAt > 0 ? Math.max(0, now - s.lastRelevantAt) / 1000 : Infinity;
        if (state !== 'COLD' && SETTLE_IDLE_SEC > 0 && idleSec < SETTLE_IDLE_SEC) return 0;

        // 执行：逐个分片 summarize（各自独立成败，成功一个推进一格水位）
        let done = 0;
        for (const shard of pending) {
            const messages = shard.items.map(it => ({ role: 'user', contentItems: [{ text: it.text, time: it.time, userId: it.userId, messageId: it.messageId }] }));
            let ok = false;
            try {
                ok = await MemoryManager.summarizeChunkWithRetry(this.session, messages);
            } catch (e) {
                log.warning('结算总结失败: ' + (e instanceof Error ? e.message : String(e)));
                ok = false;
            }
            if (!ok) {
                // 指数退避：5 → 15 → 60 分钟（失败次数在运行时，不持久化）
                const rt = runtimeOf(this);
                rt.settleFailCount = (rt.settleFailCount || 0) + 1;
                const backoffMin = rt.settleFailCount <= 1 ? 5 : rt.settleFailCount === 2 ? 15 : 60;
                s.settleBackoffUntil = now + backoffMin * 60 * 1000;
                log.warning(`结算失败，${backoffMin} 分钟后重试（已成功 ${done} 个分片）`);
                return done;
            }
            s.settledSeq = Math.max(typeof s.settledSeq === 'number' ? s.settledSeq : 0, shard.seq);
            done++;
        }
        if (done > 0) {
            runtimeOf(this).settleFailCount = 0;
            s.settleBackoffUntil = 0;
            try { s.save(true); } catch { /* 游离/桩会话无 save */ }
        }
        return done;
    }

    /**
     * L1 窗口移出（P1-2，docs/17 §2.3）：纯代码、零 LLM，让 `session_<id>` 的体积**有上界**。
     *
     * 与 L2（`archiveByTokenIfNeeded` 的 summarize 结算）解耦：这里只做"搬走原文"，
     * 不调用任何模型。窗口外的条目写进 `session_<id>:raw:<seq>` 分片（只写一次、幂等），
     * 然后从 messages 移除；`read_raw kind=user id=raw:<seq>` 仍可回查。
     *
     * 关键不变量：
     * - **绝不拆散工具原子组**（`assistant(tool_calls)` + 紧随的 `tool` 结果同进同留）；
     * - **写分片失败则不移除**（与归档同一原则：宁可留着重试，也不丢原文）；
     * - 「归档保留原文」关闭时不写分片，直接移除（省存储）。
     *
     * @returns 本次移出的条目数（0 表示未超上限或没得移）
     */
    trimToWindow(): number {
        const { ARCHIVE_KEEP_RAW } = Config.context;
        const s: any = this.session;
        if (!s || !s.sessionId) return 0;       // 游离/桩会话：无持久化身份，无处留档
        // 按会话覆盖优先（P2-1）
        const WINDOW_MAX_CHARS = s.setting?.overrideOr?.('windowMaxChars', Config.context.WINDOW_MAX_CHARS)
            ?? Config.context.WINDOW_MAX_CHARS;
        if (WINDOW_MAX_CHARS <= 0) return 0;   // 0=不移出（保持 P0 行为）

        const keep = this.pickWindowTail(WINDOW_MAX_CHARS);
        if (keep.startIndex <= 0) return 0;

        const moved = this.messages.slice(0, keep.startIndex);
        const rawItems = this.collectRawItems(moved);

        // 留档顺序：**先安全落分片，再从上下文移除**（与归档同一不变量）。
        // 关掉「归档保留原文」= 不留原文，此时跳过写分片、直接移除（省存储）。
        if (ARCHIVE_KEEP_RAW && rawItems.length > 0) {
            const nextSeq = (typeof s.rawSeq === 'number' ? s.rawSeq : 0) + 1;
            const outcome = writeShardIfAbsent(s.sessionId, nextSeq, {
                seq: nextSeq,
                from: rawItems[0].time,
                to: rawItems[rawItems.length - 1].time,
                items: rawItems,
            }, false, 'raw');
            // 写不进去就不移：宁可 session 继续变大，也不丢原文（与归档 B1 一致）
            if (outcome === 'failed') return 0;
            s.rawSeq = Math.max(typeof s.rawSeq === 'number' ? s.rawSeq : 0, nextSeq);
            s.lastRawAt = Math.floor(Date.now() / 1000);
            // 分片上限（可配）与惰性 TTL 淘汰：最旧/过期的置空（海豹无删除 API，置空即项目内先例做法）
            const { SHARD_LIMIT, SHARD_TTL_DAYS } = Config.context;
            // **必须清到"所有超出上限的"**，不能只清 `rawSeq - SHARD_LIMIT` 这一个：
            // 只清一个的话，一旦出现"多次写入但只触发部分 trim"（批量灌水、写入失败后重试、
            // 进程重启丢掉未落盘的 rawSeq 等），旧分片会永久滞留 —— 上限形同虚设。
            // 已由 sim-matrix 的 D3 用例暴露（上限设 3 时实际残留 101 个活跃分片）。
            if (SHARD_LIMIT > 0) {
                for (let seq = s.rawSeq - SHARD_LIMIT; seq >= 1; seq--) clearShard(s.sessionId, seq, 'raw');
            }
            evictExpiredShards(s.sessionId, 'raw', s.rawSeq, SHARD_TTL_DAYS, Math.floor(Date.now() / 1000));
        }

        // 移除窗口外条目（含 assistant/tool：它们已随窗口滚出，原文不值得留档）
        this.messages.splice(0, keep.startIndex);
        // **必须立即写**（不用 save(true)）：这里已经"破坏性移除"了消息，若延迟到 5 秒后写盘，
        // 期间进程被杀会留下"分片已写 + rawSeq 已推进（都只在内存）+ 上下文仍是旧内容"的错位，
        // 重载后这些消息**复活**，下次又写一份新分片 → 原文重复留档、体积重新越界。
        // 移出本身是低频事件（只在窗口真正溢出时发生），立即写的代价可接受。
        try { s.save(); } catch { /* 游离/桩会话无 save */ }
        return moved.length;
    }

    /**
     * 选出"要保留的窗口尾部"：从新到旧按**条目**粒度累加渲染字数，直到达到预算。
     * 返回 `startIndex`＝messages 中保留区间的起始下标（0 表示全部保留）。
     *
     * **工具配对是硬不变量，而不是"扫描顺序的技巧"**（本函数两次修 bug 的教训）：
     * 一条 `role:'tool'` 必须有发起它的 `assistant(tool_calls)`；反之带 toolCalls 的 assistant
     * 也必须有对应的 tool 结果。违反即请求 400。
     *
     * 因此分两步，与扫描顺序无关：
     *   ① 按预算从新到旧**粗选**一个 startIndex（纯长度累加，不关心角色）；
     *   ② **配对修复** `alignToToolPairing()`：把 startIndex 上移到"保留区间自洽"的位置。
     * 这样对连续 / 非连续 / 前导悬空 等各种形态都成立。
     */
    private pickWindowTail(budgetChars: number): { startIndex: number } {
        let used = 0;
        let startIndex = this.messages.length;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const len = buildContent(this.messages[i] as any).length;
            if (used + len > budgetChars) break;
            used += len;
            startIndex = i;
        }
        // 配对修复可能上移 startIndex（窗口略超预算），但绝不产生非法请求
        return { startIndex: this.alignToToolPairing(startIndex) };
    }

    /**
     * 把保留区间起点上移到"工具配对自洽"的位置。
     * 自洽＝区间内没有孤儿 tool、也没有结果被切在区间外的半截 assistant(tool_calls)。
     *
     * 修正规则：
     * - 区间内有孤儿 tool：owner 在区间外 → 上移到 owner；连 owner 都找不到（数据异常）→ 把该 tool 本身排除。
     * - 区间内有结果缺失的 assistant(tool_calls)：保留"模型看不到工具返回"的半截调用没有意义，
     *   且它的 tool 随后会变成孤儿 → 把该 assistant 一起移出（上移到它之后）。
     *
     * 上移可能引入新的越界关系，故循环到稳定（实际 1~2 轮，上限 O(n) 兜底）。
     */
    private alignToToolPairing(startIndex: number): number {
        let start = startIndex;
        for (let guard = 0; guard <= this.messages.length; guard++) {
            if (start >= this.messages.length) return this.messages.length;
            const resultIds = new Set<string>();
            for (let k = start; k < this.messages.length; k++) {
                const m = this.messages[k] as any;
                if (m?.role === 'tool' && m.tool_call_id) resultIds.add(String(m.tool_call_id));
            }
            let bump = -1;
            for (let k = start; k < this.messages.length; k++) {
                const m = this.messages[k] as any;
                if (!m) continue;
                if (m.role === 'tool') {
                    const rid = toolResultCallId(m);
                    const orphan = !rid || !this.hasCallIdBefore(rid, start, k);
                    if (orphan) {
                        const owner = this.findToolOwnerBefore(k, start);
                        bump = Math.max(bump, owner >= 0 ? owner : k + 1);
                    }
                } else if (m.role === 'assistant') {
                    const calls = m.toolCalls || m.tool_calls;
                    if (!Array.isArray(calls) || calls.length === 0) continue;
                    const missing = calls.some((tc: any) => tc && tc.id && !resultIds.has(String(tc.id)));
                    if (missing) bump = Math.max(bump, k + 1);
                }
            }
            if (bump < 0 || bump <= start) return start;
            start = bump;
        }
        return start;
    }

    /** 区间 `[from, to)` 内是否存在发起 `callId` 的 assistant(tool_calls) */
    private hasCallIdBefore(callId: string, from: number, to: number): boolean {
        for (let k = from; k < to; k++) {
            const m = this.messages[k] as any;
            if (!m || m.role !== 'assistant') continue;
            const calls = m.toolCalls || m.tool_calls;
            if (!Array.isArray(calls)) continue;
            if (calls.some((tc: any) => tc && tc.id && String(tc.id) === String(callId))) return true;
        }
        return false;
    }

    /** 在 `[limit, toolIdx)` 内找发起 `messages[toolIdx]` 的 assistant（按 tool_call_id 精确匹配） */
    private findToolOwnerBefore(toolIdx: number, limit = 0): number {
        const wantId = toolResultCallId(this.messages[toolIdx]);
        for (let k = toolIdx - 1; k >= limit; k--) {
            const m = this.messages[k] as any;
            if (!m || m.role !== 'assistant') continue;
            const calls = m.toolCalls || m.tool_calls;
            if (!Array.isArray(calls) || calls.length === 0) continue;
            if (!wantId || calls.some((tc: any) => tc && tc.id === wantId)) return k;
        }
        return -1;
    }

    /** 从一批消息里抽取可留档的群聊原文（复用归档分片的条目口径） */
    private collectRawItems(chunk: MessageType[]): ArchiveShardItem[] {
        const items: ArchiveShardItem[] = [];
        for (const m of chunk) {
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            for (const raw of (m as UserMessage).contentItems as UserMessageItem[]) {
                if (!raw || typeof raw.text !== 'string' || !raw.userId) continue;   // 系统条目不入分片
                if (Array.isArray(raw.rawItems) && raw.rawItems.length > 0) {
                    for (const ri of raw.rawItems) {
                        if (!ri || !ri.userId) continue;
                        items.push({ messageId: ri.messageId || '', userId: ri.userId, time: ri.time || 0, text: ri.text });
                    }
                    continue;
                }
                items.push({
                    messageId: raw.messageId || '',
                    userId: raw.userId,
                    time: raw.time || 0,
                    text: stripRawMarkers(raw.rawText ?? raw.text),
                });
            }
        }
        return items;
    }

    /**
     * 基于 token 上限执行归档（观察归档 + 分片留档 + 移除条目）：
     * - targetTokens 缺省时用「上下文最大token」配置；
     * - 超过上限时保留最近 MAX_ROUNDS 个真实 user 轮，更早消息分块归档（summarize 沉淀记忆）；
     * - 归档的群聊原文写进独立分片 key（**只写一次、永不重写**），再从上下文移除；
     * - 轮数不够时（待机群常见：只有 1 轮）按"条"归档，**不再整段硬删**（修 M7）。
     * @returns 'converged' 已收敛到上限内 / 'busy' 已有归档在飞（本次未做事，调用方可稍后重试）/
     *          'failed' 归档失败（数据保持原样，不再做降级硬删）
     */
    async archiveByTokenIfNeeded(targetTokens?: number): Promise<'converged' | 'busy' | 'failed'> {
        if (this.archiving) return 'busy';
        this.archiving = true;

        try {
            const { MAX_ROUNDS, MAX_CONTEXT_TOKENS } = Config.context;
            // 未传 target 时回退配置上限；配置为 0（P2-3：跟随探测窗口）时解析为有效预算。
            // 解析仍拿不到（未探测过）时回退默认值——**不再当作"不限制"**，否则归档永远不触发。
            const target = targetTokens && targetTokens > 0
                ? targetTokens
                : resolveEffectiveMaxTokens(MAX_CONTEXT_TOKENS, getProbedContextWindow(Model.getChatModel('chat')?.name || '')).tokens;
            const keepRounds = MAX_ROUNDS > 0 ? MAX_ROUNDS : 5;
            let converged = true;

            while (estimateContextMessagesTokens(this.messages) > target) {
                const keepStart = getKeepStart(this.messages, keepRounds);
                const toArchive = this.messages.slice(0, keepStart);

                if (toArchive.length > 0) {
                    if (await this.archivePrefix(toArchive)) continue;
                } else if (await this.archiveOldestItems()) {
                    continue;
                }
                // 归档失败：不删数据、不做硬删兜底，如实返回"未收敛"（调用方据此提示/重试）
                converged = false;
                break;
            }

            const rt = runtimeOf(this);
            if (converged) {
                rt.archiveFailCount = 0;
                return 'converged';
            }
            // 连续失败兜底：summarize 长期不可用（或超长内容集中在 assistant/tool、无 user 条目可归档）时，
            // 若一直只返回 failed，会话会永久无法回复。连续失败到阈值后允许一次"降级丢弃最早轮次"（不写记忆），
            // 让会话恢复可用——这是旧 forceFit 行为的受限版，且日志可见。
            rt.archiveFailCount++;
            if (rt.archiveFailCount < ARCHIVE_FAIL_LIMIT) return 'failed';
            rt.archiveFailCount = 0;
            await this.forceFitAsLastResort(target);
            return estimateContextMessagesTokens(this.messages) <= target ? 'converged' : 'failed';
        } finally {
            this.archiving = false;
        }
    }

    /** 归档连续失败后的最后手段：丢弃最早的轮次（不含 summarize），只保证会话还能回复 */
    private async forceFitAsLastResort(targetTokens: number): Promise<void> {
        let safety = 0;
        while (estimateContextMessagesTokens(this.messages) > targetTokens && this.messages.length > 0 && safety < 10000) {
            if (!dropOldestRound(this.messages)) break;
            safety++;
        }
        log.warning(`[ctx-cost] 归档连续失败 ${ARCHIVE_FAIL_LIMIT} 次，已降级丢弃最早轮次（不写记忆），剩余 token=${estimateContextMessagesTokens(this.messages)}`);
    }

    private async archivePrefix(toArchive: MessageType[]): Promise<boolean> {
        const chunks = splitMessagesByToken(toArchive, ARCHIVE_CHUNK_TOKENS);
        // 「归档保留原文」关闭时：**仍然 summarize 沉淀记忆，只是不写归档分片**（不留原文，省存储）。
        // 语义区分：开关只控制"原文档留"，不控制"记忆沉淀"——否则关掉开关会让历史既不进记忆也查不到，等于白丢。
        const keepRaw = Config.context.ARCHIVE_KEEP_RAW;

        for (const chunk of chunks) {
            const ok = await MemoryManager.summarizeChunkWithRetry(this.session, chunk);
            if (!ok) return false;
            if (keepRaw) {
                // 原文必须先安全落进归档分片（幂等），才允许从上下文移除
                if (this.writeArchiveShard(chunk) === 'failed') return false;
            }
            // chunk 始终是当前消息数组最前的一段（前面的块成功后已移除）
            this.messages.splice(0, chunk.length);
            try { this.session.save(); } catch { /* 无宿主会话时跳过保存（测试/游离 Context） */ }
        }

        return true;
    }

    /**
     * 轮数不够时的兜底归档：按 contentItem 粒度取出最旧一段（受 ARCHIVE_CHUNK_TOKENS 限制），
     * 先 summarize 沉淀记忆，再写归档分片并移除条目。**不做整段硬删**（修 M7）。
     */
    private async archiveOldestItems(): Promise<boolean> {
        const picked: MessageType[] = [];
        let tokens = 0;
        for (const m of this.messages) {
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            const taken: UserMessageItem[] = [];
            for (const it of (m as UserMessage).contentItems as UserMessageItem[]) {
                const t = estimateMessageTokens({ role: 'user', contentItems: [it] } as any);
                if (tokens > 0 && tokens + t > ARCHIVE_CHUNK_TOKENS) break;
                taken.push(it);
                tokens += t;
            }
            if (taken.length === 0) continue;
            picked.push({ role: 'user', contentItems: taken } as UserMessage);
            if (tokens >= ARCHIVE_CHUNK_TOKENS) break;
        }
        if (picked.length === 0) return false;

        // 「归档保留原文」关闭时：**仍然 summarize 沉淀记忆，只是不写归档分片**（不留原文，省存储）
        const ok = await MemoryManager.summarizeChunkWithRetry(this.session, picked);
        if (!ok) return false;
        if (Config.context.ARCHIVE_KEEP_RAW) {
            if (this.writeArchiveShard(picked) === 'failed') return false;   // 未留档成功则不移除
        }
        this.removeArchivedItems(picked);
        try { this.session.save(); } catch { /* 游离 Context */ }
        return true;
    }

    /**
     * 把这批消息里的 user 条目原文写进归档分片（幂等：分片已存在则跳过），并推进 archiveSeq。
     * @returns 'stored' 已安全留档（可移除来源）/ 'nothing' 没有可留档的群聊原文（移除是安全的）/ 'failed' 写入失败（**不得移除来源**）
     */
    private writeArchiveShard(chunk: MessageType[]): 'stored' | 'nothing' | 'failed' {
        const s: any = this.session;
        // 游离/桩会话（无 archiveSeq 或无语会 id）没有持久化身份，无处留档——此时移除是安全的
        if (!s || typeof s.archiveSeq !== 'number' || !s.sessionId) return 'nothing';
        const items: ArchiveShardItem[] = [];
        for (const m of chunk) {
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            for (const raw of (m as UserMessage).contentItems as UserMessageItem[]) {
                if (!raw || typeof raw.text !== 'string' || !raw.userId) continue;   // 系统条目（事件/提示）不入分片
                if (Array.isArray(raw.rawItems) && raw.rawItems.length > 0) {
                    // 压缩块：块内逐条原文才是真原文
                    for (const ri of raw.rawItems) {
                        if (!ri || !ri.userId) continue;
                        items.push({ messageId: ri.messageId || '', userId: ri.userId, time: ri.time || 0, text: ri.text });
                    }
                    continue;
                }
                items.push({
                    messageId: raw.messageId || '',
                    userId: raw.userId,
                    time: raw.time || 0,
                    text: stripRawMarkers(raw.rawText ?? raw.text),
                });
            }
        }
        if (items.length === 0) return 'nothing';   // 这批里没有群聊原文，无需留档即可移除
        const seq = s.archiveSeq + 1;
        // B1：存在性由持久化水位（archiveSeq）判定，**不靠读分片本体**——storageGet 对不存在的 key
        // 也抛异常，"不存在"与"读失败"不可区分，读异常不能当作存在性结论（详见 archive_store.ts）。
        const knownExists = seq <= s.archiveSeq;
        const outcome = writeShardIfAbsent(s.sessionId, seq, {
            seq,
            from: items[0].time,
            to: items[items.length - 1].time,
            items,
        }, knownExists);
        if (outcome === 'failed') return 'failed';
        // 'exists' 也必须把序号推进到该 seq：否则一旦出现"分片已写、archiveSeq 未落盘"的错位
        // （崩溃/存档写失败），后续每批都会撞上同一个 seq（永远 exists）→ 原文再也不会写进分片。
        s.archiveSeq = Math.max(s.archiveSeq, seq);
        s.lastArchivedAt = Math.floor(Date.now() / 1000);
        // 分片数量上限（可配）：最旧的置空（海豹没有 delete API，置空即项目内先例做法）
        // 同 raw 分支：必须清到"所有超出上限的"，只清一个会在跳号/重试时让旧分片永久滞留。
        const { SHARD_LIMIT } = Config.context;
        if (SHARD_LIMIT > 0) {
            for (let old = s.archiveSeq - SHARD_LIMIT; old >= 1; old--) clearShard(s.sessionId, old, 'arc');
        }
        return 'stored';
    }

    /** 从 messages 中移除已归档的条目（按条目对象定位，保持其余内容与顺序不变） */
    private removeArchivedItems(archived: MessageType[]): void {
        const marked = new Set<any>();
        for (const m of archived) {
            if (Message.getMessageType(m) !== 'user') continue;
            for (const it of (m as UserMessage).contentItems || []) marked.add(it);
        }
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            const um = m as UserMessage;
            um.contentItems = um.contentItems.filter(it => !marked.has(it));
            if (um.contentItems.length === 0) this.messages.splice(i, 1);
        }
    }

    /** 运行时归档锁，不持久化 */
    private archiving = false;

    getUserById(userId: string | number): User | null {
        const normalizedId = normalizeUserId(userId, getPlatform(this.sessionId));
        if (!normalizedId || this.session.checkIgnoredUserId(normalizedId)) return null;
        return User.get(normalizedId);
    }
    get userInfoList(): { isPrivate: true, id: string, name: string }[] {
        const userMap: { [key: string]: { isPrivate: true, id: string, name: string } } = {};
        for (const m of this.messages) {
            if (m.role !== 'user' || !(m as any).contentItems) continue;
            for (const item of (m as any).contentItems) {
                if (!item.userId) continue;
                if (!userMap[item.userId]) {
                    const u = User.get(item.userId);
                    userMap[item.userId] = {
                        isPrivate: true,
                        id: item.userId,
                        name: u.userName || item.userId
                    };
                }
            }
        }
        return Object.values(userMap);
    }

    async setName(epId: string, gid: string, uid: string, mod: 'nickname' | 'card') {
        let name = '';
        switch (mod) {
            case 'nickname': {
                const strangerInfo = await callOb11Api(epId, "get_stranger_info", { user_id: uid.replace(/^.+:/, ""), no_cache: true });
                if (!strangerInfo || !strangerInfo.nickname) {
                    log.warning(`未找到用户<${uid}>的昵称`);
                    break;
                }
                name = strangerInfo.nickname;
                break;
            }
            case 'card': {
                if (!gid) break;
                const memberInfo = await callOb11Api(epId, "get_group_member_info", { group_id: gid.replace(/^.+:/, ""), user_id: uid.replace(/^.+:/, ""), no_cache: true });
                if (!memberInfo) {
                    log.warning(`获取用户<${uid}>的群成员信息失败，尝试使用昵称`);
                    await this.setName(epId, gid, uid, 'nickname');
                    return;
                }
                name = memberInfo.card || memberInfo.nickname;
                if (!name) {
                    await this.setName(epId, gid, uid, 'nickname');
                    return;
                }
                break;
            }
        }
        if (!name) {
            log.warning(`用户<${uid}>未设置昵称或群名片`);
            return;
        }
        const u = User.get(uid);
        u.userName = name;
        User.save(u);
    }
    getGroupById(groupId: string | number): Group | null {
        const normalizedId = normalizeGroupId(groupId, getPlatform(this.sessionId));
        if (!normalizedId) return null;
        return Group.get(normalizedId);
    }
    async findImage(_ctx: seal.MsgContext, id: string): Promise<Image | null> {
        if (/^user_avatar[:：?]/.test(id)) {
            const userId = normalizeUserId(id.replace(/^user_avatar[:：?]/, ''), getPlatform(this.sessionId));
            if (userId) return Image.getUserAvatar(userId);
            return null;
        }
        if (/^group_avatar[:：?]/.test(id)) {
            const groupId = normalizeGroupId(id.replace(/^group_avatar[:：?]/, ''), getPlatform(this.sessionId));
            if (groupId) return Image.getGroupAvatar(groupId);
            return null;
        }
        const img = Image.get(id);
        if (img) return img;
        const { LOCAL_IMAGE_PATH_MAP } = Config.image as any;
        if (LOCAL_IMAGE_PATH_MAP && Object.prototype.hasOwnProperty.call(LOCAL_IMAGE_PATH_MAP, id)) {
            return Image.createLocalImage(id, LOCAL_IMAGE_PATH_MAP[id]);
        }
        return this.session.memory.findImage(id);
    }

    async updateName(epId: string, gid: string, uid: string) {
        switch (this.autoNameMod) {
            case 1: {
                try {
                    await withTimeout(() => this.setName(epId, gid, uid, 'nickname'), 5000);
                } catch (e) {
                    log.warning(`自动改名（昵称）失败: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }
            case 2: {
                try {
                    await withTimeout(() => this.setName(epId, gid, uid, 'card'), 5000);
                } catch (e) {
                    log.warning(`自动改名（群名片）失败: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }
        }
    }

}
