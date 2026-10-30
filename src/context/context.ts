// 会话上下文：消息增删/忽略名单/上下文摘要与旧路径截断/按 ID 获取目标/图片查找
import type Agent from "../agent/agent";
import Config from "../config/config";
import { getAgent } from "../core/ports/agent_registry";
import Logger from "../logger";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import User from "../session/user";
import { ToolCall, ToolContentPart } from "../tool/types";
import { LEGACY_USER_MESSAGE_MAX_TOKENS } from "../utils/context_limits";
import { buildToolTruncateMarkerTokens, buildUserTruncateMarker, buildUserTruncateMarkerTokens } from "../utils/raw_marker";
import { TypeDescriptor } from "../utils/revive";
import { stripInternalTags } from "../utils/string";
import { truncateMiddleToTokenBudget, truncateToTokenBudget } from "../utils/token_budget";
import { estimateTextTokens } from "../utils/token_estimate";

import { archiveByTokenIfNeeded as archiveByTokenIfNeededImpl, settleWindowIfNeeded as settleWindowIfNeededImpl, trimToWindow as trimToWindowImpl } from "./archiver";
import { demoteMediaParts } from "./content/render";
import { parseText } from "./content/text_parse";
import { normalizeToolResult } from "./content/tool_result";
import { type ConversationEvent, type Part, toolResultEventId } from "./events";
import { EVENT_PAGE_MAX_SINGLE_EVENT_BYTES, measureEventPageBytes } from "./log/page_store";
import Message from "./message";
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

/** v2 工具调用配对表：只存在于运行时，不进入持久化字段 */
interface V2ToolGroup { turnId: string; groupId: string }
const v2ToolGroups = new WeakMap<object, { nextTurn: number; map: Map<string, V2ToolGroup> }>();

function v2GroupsOf(context: object): { nextTurn: number; map: Map<string, V2ToolGroup> } {
    let groups = v2ToolGroups.get(context);
    if (!groups) {
        groups = { nextTurn: 0, map: new Map() };
        v2ToolGroups.set(context, groups);
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

/** 单事件页落盘余量（字节）：给 flush 时实际页号/seq 位数增长与测量差异留空间 */
const TOOL_RESULT_STORAGE_PAGE_MARGIN_BYTES = 256;
/** 存储层截断标记前缀：与展示层截断（compile 的 token 上限 + read_raw 指针）是两层 */
const TOOL_RESULT_STORAGE_MARK = '[tool-result-truncated-for-storage:';

interface ToolResultStorageInput {
    turnId: string;
    groupId: string;
    callId: string;
    name?: string;
    parts: readonly Part[];
}

/** 构造与 store 实际入库同口径的 tool_result 事件（仅用于「单事件伪页」字节测量） */
function toolResultStorageEvent(input: ToolResultStorageInput, parts: readonly Part[], seq: number): ConversationEvent {
    const at = Math.floor(Date.now() / 1000);
    return {
        kind: 'tool_result',
        turnId: input.turnId,
        groupId: input.groupId,
        callId: input.callId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        parts: parts as Part[],
        eventId: toolResultEventId(input.groupId, input.callId),
        seq,
        at,
        recvAt: at,
    };
}

/** 单事件伪页的负载字节数（与 page_store.buildEventPage 的 bytes 口径一致） */
function measureToolResultStoragePage(input: ToolResultStorageInput, parts: readonly Part[], seq: number, pageNo: number): number {
    return measureEventPageBytes({
        pageNo,
        seqStart: seq,
        seqEnd: seq,
        events: [toolResultStorageEvent(input, parts, seq)],
    });
}

/** 按字符预算保留各 text part（头 2/3 + 尾 1/3），并追加存储截断标记；非 text part 原样保留 */
function buildStorageLimitedParts(parts: readonly Part[], keepChars: number, totalChars: number): Part[] {
    const out: Part[] = parts.map(part => (part.type === 'text' ? { ...part } : part));
    const textParts = out.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
    let remaining = Math.max(0, Math.min(Math.floor(keepChars), totalChars));
    for (const part of textParts) {
        const original = part.text;
        const share = totalChars > 0 ? Math.floor((original.length * Math.floor(keepChars)) / totalChars) : 0;
        const keep = Math.max(0, Math.min(original.length, share, remaining));
        remaining -= keep;
        part.text = keep <= 0 ? '' : (keep >= original.length ? original : truncateMiddle(original, keep));
    }
    const kept = out.filter(part => !(part.type === 'text' && part.text.length === 0));
    const marker = `${TOOL_RESULT_STORAGE_MARK} 保留 ${Math.max(0, Math.floor(keepChars))}/${totalChars} 字符，完整结果可重新执行工具获取]`;
    const lastText = [...kept].reverse().find((part): part is { type: 'text'; text: string } => part.type === 'text');
    if (lastText) lastText.text = `${lastText.text}\n${marker}`;
    else kept.push({ type: 'text', text: marker });
    return kept;
}

/**
 * 单事件 tool_result 存储上限（极端兜底）：写入账本前若「单事件页」字节超过
 * `EVENT_PAGE_MAX_SINGLE_EVENT_BYTES`，按字符二分截断 text parts，保证 buildEventPage 能接受。
 * 否则 store.flush 会永久卡在同一张失败页（buffer 不前进），重启后整批事件丢失、read_raw 不可达。
 * 返回 null 表示无需截断。
 */
function limitToolResultForStorage(
    input: ToolResultStorageInput,
    seq: number,
    pageNo: number,
): { parts: Part[]; beforeBytes: number; afterBytes: number; totalChars: number; keptChars: number } | null {
    const measure = (parts: readonly Part[]): number => measureToolResultStoragePage(input, parts, seq, pageNo);
    const beforeBytes = measure(input.parts);
    if (beforeBytes <= EVENT_PAGE_MAX_SINGLE_EVENT_BYTES) return null;
    const totalChars = input.parts.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0);
    // 目标留余量：flush 时的实际页号可能比当前 head.nextPageNo 更大（位数增长）
    const targetBytes = EVENT_PAGE_MAX_SINGLE_EVENT_BYTES - TOOL_RESULT_STORAGE_PAGE_MARGIN_BYTES;
    let low = 0;
    let high = totalChars;
    let best: { parts: Part[]; keptChars: number; bytes: number } | null = null;
    while (low <= high) {
        const keep = Math.floor((low + high) / 2);
        const parts = buildStorageLimitedParts(input.parts, keep, totalChars);
        const bytes = measure(parts);
        if (bytes <= targetBytes) {
            best = { parts, keptChars: keep, bytes };
            low = keep + 1;
        } else {
            high = keep - 1;
        }
    }
    if (!best) {
        // 理论兜底：只保留标记一定远小于上限（无 text part 的超大结构极少）
        const parts = buildStorageLimitedParts(input.parts, 0, totalChars);
        best = { parts, keptChars: 0, bytes: measure(parts) };
    }
    return { parts: best.parts, beforeBytes, afterBytes: best.bytes, totalChars, keptChars: best.keptChars };
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
    /** 本轮/本会话因 context_too_long 临时收紧的请求预算上限；用户显式设置或重载时清除 */
    private v2BudgetCap: number | null = null;
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

    /** 序列化：未接入事件账本时保留旧 messages；接入后只存配置/运行字段，消息由页存储负责 */
    toJSON(): Record<string, unknown> {
        const out: Record<string, unknown> = {
            agentName: this.agentName,
            sessionId: this.sessionId,
            ignoreList: this.ignoreList,
            lastReply: this.lastReply,
            counter: this.counter,
            timer: this.timer,
            autoNameMod: this.autoNameMod,
        };
        if (!this.v2Enabled) out.messages = this.messages;
        const legacy = this as unknown as Record<string, unknown>;
        for (const key of ['archiveSeq', 'rawSeq', 'settledSeq', 'lastArchivedAt', 'lastRawAt']) {
            if (legacy[key] !== undefined) out[key] = legacy[key];
        }
        return out;
    }

    /** 由 SessionService 在迁移/打开后调用：此后写入/读取走 v2 */
    initV2(service: ContextService | null): void {
        this.v2Service = service;
        this.v2Projection = null;
        this.v2BudgetCap = null;
    }

    /** context_too_long 后的临时预算上限（token）；null=未收紧 */
    get v2BudgetCapValue(): number | null {
        return this.v2BudgetCap;
    }

    setV2BudgetCap(tokens: number | null): void {
        this.v2BudgetCap = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
            ? Math.floor(tokens)
            : null;
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
            if (!result.ok) log.warning('上下文落盘失败: ' + (result.error ?? 'unknown'));
        }).catch(error => log.warning('上下文落盘异常: ' + (error instanceof Error ? error.message : String(error))));
    }

    private appendV2User(text: string, userId: string, messageId: string): void {
        const service = this.v2Service;
        if (!service) return;
        service.appendUser(userId, messageId, parseText(stripInternalTags(text), 'model-output'));
        this.invalidateV2();
        this.flushV2();
    }

    private appendV2Assistant(text: string, messageId: string, reasoningContent?: string): void {
        const service = this.v2Service;
        if (!service) return;
        // INV-8：assistant 消息不允许图片（API 明确拒绝）。模型回复里的 [img:ID] 等媒体标签
        // 解析后一律降级为文本 part 再入库，避免编译进 assistant 消息。
        service.appendAssistant(messageId, demoteMediaParts(parseText(stripInternalTags(text), 'model-output')), {
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
            log.warning('上下文已启用：clearMessages 不再直接删消息，请使用 .ai ctx hide/purge');
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
     * 旧回退路径（无事件账本）：用户消息超长时**纯代码截断**，不再调用任何 LLM。
     * 头+尾保留、原文写 rawText（不参与渲染/预算），供 read_raw/grep_raw(kind=user) 按 msg_id 回查。
     */
    static truncatePreserveIfLong(text: string): { display: string; original: string; changed: boolean; totalTokens: number; shownTokens: number } {
        const original = text;
        const slice = truncateMiddleToTokenBudget(text, LEGACY_USER_MESSAGE_MAX_TOKENS, estimateTextTokens);
        return { display: slice.text, original, changed: slice.truncated, totalTokens: slice.totalTokens, shownTokens: slice.shownTokens };
    }

    /** 待机判定（配额用；v2 不再使用冷/热状态机） */
    private isStandbySession(): boolean {
        const s: any = this.session;
        return !!(s?.setting?.standby || Config.base.GLOBAL_STANDBY);
    }

    /** 冷态判定（仅旧回退路径使用） */
    private isColdSession(): boolean {
        const s: any = this.session;
        if (!s || typeof s.stateOf !== 'function') return false;
        return s.stateOf() === 'COLD';
    }

    /** 待机入库配额（P2-2）：本会话**每小时**最多入库 `待机入库配额` 条普通群消息（0=不限制）。
     * 计数放模块级 WeakMap（运行时状态，不持久化）——重载后重置等价于"新的一小时"，是安全的放宽。
     * @returns 是否允许本次入库
     */
    private allowColdIngest(): boolean {
        const quota = Config.context.STANDBY_QUOTA;
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
     * 冷态入库条目：**零 LLM** —— 只做纯代码截断（留头留尾），原文进 rawText 并带 `content-truncated` 标记。
     * 标记 compressed=true 表示该条已做过有损处理（历史兼容语义；新写入不再有 LLM 压缩）。
     */
    private buildColdUserItem(text: string, userId: string, messageId: string): UserMessageItem {
        // 按会话覆盖优先（P2-1）
        const s: any = this.session;
        const COLD_SINGLE_TRUNCATE = s?.setting?.overrideOr?.('coldTruncate', 0) ?? 0;
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
     * 用户消息入库（串行化入口）：两条消息并发时会在 await 期间互相覆盖 `contentItems`，
     * 这里用每会话的 promise 链把入库串行化——运行时状态放模块级 WeakMap，不污染持久化字段。
     */
    async addUserMessage(ctx: seal.MsgContext, text: string, userId: string, messageId: string): Promise<void> {
        if (this.v2Service) {
            // 只有启用配额时才限流；按待机判定，不进入旧冷热状态机
            if (Config.context.STANDBY_QUOTA > 0 && this.isStandbySession() && !this.allowColdIngest()) return;
            this.appendV2User(text, userId, messageId);
            return;
        }
        const rt = runtimeOf(this);
        const run = rt.ingestChain.then(() => this.addUserMessageInner(ctx, text, userId, messageId));
        rt.ingestChain = run.then(() => undefined, () => undefined);   // 前一次失败不阻塞后续入库
        return run;
    }

    // 用户消息入库：冷态（待机）与旧回退路径都只做纯代码截断（零 LLM）；
    // 截断前原文保留在条目 rawText（不参与渲染与 token 估算），展示文本末尾带标记，
    // AI 可用 read_raw/grep_raw(kind=user) 按 msg_id 核对原文
    private async addUserMessageInner(ctx: seal.MsgContext, text: string, userId: string, messageId: string) {
        // 自动改名：按 autoNameMod 设置，在用户首次出现时更新上下文中的名字
        if (this.autoNameMod > 0) {
            try {
                await this.updateName(ctx.endPoint.userId, ctx.group ? ctx.group.groupId : '', userId);
            } catch (e) {
                log.warning('自动改名失败: ' + (e instanceof Error ? e.message : String(e)));
            }
        }

        // 冷态（待机且无在途对话）：入库零 LLM —— 只追加 + 纯代码截断，不做合并压缩
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

        // —— 热态旧路径：单条超长纯代码截断（头+尾），原文进 rawText 供 read_raw 回查 ——
        const single = Context.truncatePreserveIfLong(text);
        let itemText = stripInternalTags(single.display);
        const rawText = single.changed ? stripInternalTags(single.original) : undefined;
        if (rawText !== undefined) {
            // 防注入：入库前兜底剥离内部标签（主入口在 transformArrayToContent）
            itemText = stripInternalTags(itemText);
            itemText += buildUserTruncateMarkerTokens(single.totalTokens, single.shownTokens, messageId);
        }
        this.appendUserItem({
            text: itemText,
            time: Math.floor(Date.now() / 1000),
            userId,
            messageId,
            ...(single.changed ? { compressed: true } : {}),
            ...(rawText !== undefined ? { rawText } : {})
        });
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
        // 仅当原位置仍是"系统用户消息"（未被历史合并压缩/清理/归档改写）时才可安全替换
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
            const groups = v2GroupsOf(this);
            groups.nextTurn++;
            const turnId = `t:${groups.nextTurn}`;
            toolCalls.forEach((call, index) => {
                const callId = String(call.id ?? '');
                if (!callId) return;
                const groupId = `${turnId}:${index}`;
                const fn = call.function ?? { name: '', arguments: '{}' };
                this.v2Service!.appendToolCall({
                    turnId,
                    groupId,
                    callId,
                    name: String(fn.name ?? ''),
                    args: String(fn.arguments ?? '{}'),
                    ...(reasoningContent !== undefined ? { reasoning: reasoningContent } : {}),
                });
                groups.map.set(callId, { turnId, groupId });
            });
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
    }

    // 工具回调消息：完整原文写入事件账本（超长在请求编译层按 token 上限截断并给 read_raw 指针）；
    // 旧回退路径（无事件账本）在此按 token 上限 head 截断，原文写 rawText 供 read_raw kind=tool 回查。
    async addToolCallbackMessage(text: string, toolCallId: string, toolName?: string, contentParts?: ToolContentPart[]) {
        if (this.v2Service) {
            let parts: Part[] = [];
            try {
                parts = normalizeToolResult({ text, contentParts }, {
                    allowImageRefs: true,
                    noteUnregisteredMedia: false,
                    maxMedia: Config.image.MAX_IMAGES_PER_TOOL_RESULT,
                });
            } catch {
                parts = [];
            }
            if (parts.length === 0 && text) parts = [{ type: 'text', text }];
            const groups = v2GroupsOf(this);
            let group = groups.map.get(toolCallId);
            if (!group) {
                // 进程重启/续跑丢失了内存配对表：从账本里找同 callId 的调用补回配对
                const events = this.v2Service.snapshot().events;
                let call: (typeof events)[number] | undefined;
                for (let i = events.length - 1; i >= 0; i--) {
                    const event = events[i];
                    if (event.kind === 'tool_call' && String((event as { callId?: unknown }).callId ?? '') === toolCallId) {
                        call = event;
                        break;
                    }
                }
                if (call && call.kind === 'tool_call') group = { turnId: call.turnId, groupId: call.groupId };
            }
            const turnId = group?.turnId ?? `orphan:${toolCallId}`;
            const groupId = group?.groupId ?? `orphan:${toolCallId}`;
            // 存储层上限（极少数超大工具结果，如拉取群历史）：只在写账本前截断 text parts，
            // 保证单事件页 <= EVENT_PAGE_MAX_SINGLE_EVENT_BYTES 可落盘。
            // 展示层不受影响：compile 仍按 token 上限截断并给 read_raw 指针（原文不可回查时才需重新执行工具）。
            const head = this.v2Service.head();
            const limited = limitToolResultForStorage(
                { turnId, groupId, callId: toolCallId, name: toolName, parts },
                head.nextSeq,
                head.nextPageNo,
            );
            const accepted = this.v2Service.appendToolResult({
                turnId,
                groupId,
                callId: toolCallId,
                name: toolName,
                parts: limited ? limited.parts : parts,
            });
            if (limited) {
                const seqText = accepted.length > 0 ? `seq=${accepted[0]}` : '未入库（重复事件）';
                log.warning(
                    `工具结果超单事件页上限，已截断入账本：${seqText}，页负载 ${limited.beforeBytes}→${limited.afterBytes} 字节，`
                    + `保留 ${limited.keptChars}/${limited.totalChars} 字符；被截断原文可重新执行工具获取`,
                );
            }
            this.invalidateV2();
            this.flushV2();
            return;
        }
        const maxTokens = Config.tool.TOOL_RESULT_MAX_TOKENS;
        // use_skill 自己已做 12000 字符分页，且「续读 offset」在结果末尾：
        // 再套通用 head 截断会把续读提示一起截掉，导致模型无法续读，故豁免。
        // 直接调用（toolName=use_skill）与 call_tool 包装（工具输出以 `use_skill returned:` 开头）都要识别。
        // 内容长度上限仍由 use_skill 的 MAX_SKILL_CONTENT_LENGTH 保证。
        const skipTruncate = toolName === 'use_skill'
            || /^## Skill: /.test(text)
            || /^use_skill returned:\n/.test(text);
        // 截断前原文：仅当文本确实被截断后保留，供只读工具按需读取（不参与渲染/预算）
        let rawText: string | undefined;
        if (!skipTruncate && maxTokens > 0) {
            const slice = truncateToTokenBudget(text, maxTokens, estimateTextTokens);
            if (slice.truncated) {
                rawText = text;
                text = slice.text;
            }
        }
        // 防注入：工具返回内容（如历史消息、网页文本）中的内部上下文标签直接剥离，不进入上下文
        text = stripInternalTags(text);
        if (rawText !== undefined) {
            // 原文与展示文本走同一防注入处理；附加指针提示让模型知道内容被截断、可以按需翻原文
            rawText = stripInternalTags(rawText);
            text += buildToolTruncateMarkerTokens(estimateTextTokens(rawText), estimateTextTokens(text), toolCallId);
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

    async settleWindowIfNeeded(now: number = Date.now()): Promise<number> {
        if (this.v2Service) return 0;
        return settleWindowIfNeededImpl(this, now);
    }

    trimToWindow(): number {
        if (this.v2Service) return 0;
        return trimToWindowImpl(this);
    }

    async archiveByTokenIfNeeded(targetTokens?: number): Promise<'converged' | 'busy' | 'failed'> {
        if (this.v2Service) {
            // v2 不在错误路径物理归档：按报文解析出的目标收紧下一轮编译预算，
            // 否则重发会完全复现同一请求，形成“归档空转”。
            if (typeof targetTokens === 'number' && targetTokens > 0) this.v2BudgetCap = Math.floor(targetTokens);
            return 'converged';
        }
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

