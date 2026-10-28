// Context v2 请求编译器（纯函数）：唯一决定"本轮给模型看什么"的地方。
//
// 输入：store 快照（事件 + 记录 + head）、已构建好的前缀消息（system/预设）、预算与能力。
// 输出：OpenAI 兼容消息数组（provider 层再做方言转换）。
//
// 规则（对应设计 INV-A/B/C）：
// - 单元从新到旧选择；**最新单元必留**；预算不够时截断最新单元的文本并带 read_raw 指针；
// - 工具组整组选择；不完整组降级为文本，不产生无结果的 tool_calls；
// - **摘要边界**：当前 epoch 的滚动摘要覆盖 [epochStart, S]；S 之前的事件不再重复展示原文，
//   只注入摘要（"已摘要内容不再以原文出现"）。过滤按**单元**（工具组可能晚到，不能按事件 seq 切）；
// - 被省略区间：注入 rolling summary；没有摘要则显式提示缺口（绝不静默）；
// - **标签分级**：从最新往回累计 user/assistant/system 消息 token，边界内保留 [msg_id]（user 同时保留 [time]）；
//   边界外 user 去掉 [msg_id]、[time] 只在时间锚点出现（首条未标记消息 / 静默≥1h / 跨天 / 每 100 条）；
// - 纯函数：不读 Config/seal/storage，时间/名字/估算全部注入，便于单测与 goldens。
import {
    SUMMARY_MAX_CHARS,
    TAG_ANCHOR_EVERY_MESSAGES,
    TAG_ANCHOR_GAP_SEC,
} from "../../utils/context_limits";
import {
    buildEventRangeTruncateMarker,
    earlierSummaryBlock,
    earlierSummaryGapText,
    SYSTEM_NAME,
    TOOL_RESULT_CLOSE,
    toolResultHeader,
} from "../../utils/protocol";
import type { LLMCaps, MediaResolvers } from "../content/descriptors";
import type { LLMContentBlock, LLMDialect } from "../content/llm";
import { toLLM, toLLMText } from "../content/llm";
import { renderText } from "../content/render";
import type { ConversationEvent, Part, SummaryRecord } from "../events";
import type { ContextSnapshot } from "../store";

import {
    applyEdit,
    applyVisibility,
    buildRecordIndex,
    latestSummary,
    RecordIndex,
} from "./records";
import {
    ConversationUnit,
    estimateUnitTokens,
    segmentUnits,
} from "./units";

export type CompiledRole = 'system' | 'user' | 'assistant' | 'tool';

export interface CompiledToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface CompiledMessage {
    role: CompiledRole;
    content: string | LLMContentBlock[];
    tool_calls?: CompiledToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
}

export type CompileMode = 'native' | 'prompt-engineering';

export interface CompileOptions {
    snapshot: ContextSnapshot;
    /** 已构建好的前缀（system prompt、预设上下文等），不计入上下文选择 */
    prefixMessages?: readonly CompiledMessage[];
    /** 整个请求的 token 预算（含前缀与 tools 预留） */
    budgetTokens: number;
    /** prefixMessages 的 token 估算；缺省用 estimateTextTokens 粗算 */
    prefixTokens?: number;
    /** 工具 schema 预留 token */
    toolsReserveTokens?: number;
    mode?: CompileMode;
    caps?: LLMCaps;
    dialect?: LLMDialect;
    resolve?: MediaResolvers;
    /**
     * tool 消息是否允许图片块（默认 true）。部分网关不支持 tool 角色带图；
     * 关闭时 tool 结果用纯文本投影（[img:ID] 保留）。见 20 号方案 INV-12。
     */
    toolImages?: boolean;
    /**
     * 标签边界 token（保留强度 × 永久预算）：从最新往回累计 user/assistant/system 消息 token，
     * 未超边界的消息保留 [msg_id]（user 同时保留 [time]）；更旧的消息去 [msg_id]、[time] 只在锚点。
     * 不传 = 保持旧行为（全部带标签）。
     */
    tagBoundaryTokens?: number;
    /** 跨天锚点用的日期键（缺省用 formatTime 的日期前缀；单测可注入固定实现） */
    formatDateKey?: (at: number) => string;
    /** 必填：文本 token 估算（仓库内用 estimateTextTokens） */
    estimateTextTokens: (text: string) => number;
    /** 必填：单事件 token 估算（应包含 role/parts/tool_calls 口径） */
    estimateEventTokens: (event: ConversationEvent) => number;
    /** 注入的展示格式化钩子（避免编译器依赖 Config/User/日期格式） */
    resolveUserName?: (uid: string) => string;
    formatTime?: (at: number) => string;
    formatMessageId?: (msgId: string) => string;
    /** 单个 summary 注入文本的硬上限（字符），防止摘要本身撑爆预算 */
    summaryMaxChars?: number;
}

export interface CompileStats {
    unitsTotal: number;
    unitsSelected: number;
    firstSelectedSeq: number;
    lastSelectedSeq: number;
    estimatedTokens: number;
    truncated: boolean;
    summaryInjected: boolean;
    gapInjected: boolean;
    /** 当前 epoch 有效滚动摘要覆盖到的 seq（0=没有可用摘要 / 因 stale 回退） */
    summaryBoundarySeq: number;
    /** 摘要区间与 edit/redact 相交，本轮回退为旧行为（不按摘要边界裁剪） */
    summaryStale: boolean;
    /** 未摘要原文中因预算被裁掉的区间（null=没有裁剪；用于触发压缩，等价于「预算到顶」） */
    omittedFromSeq: number | null;
    omittedToSeq: number | null;
    /** 标签边界内累计的消息 token（user/assistant/system；不含工具结果） */
    retainedTokens: number;
    /** 本轮回合带 [msg_id] 标签的消息条数 */
    taggedMessages: number;
}

export interface CompileResult {
    messages: CompiledMessage[];
    stats: CompileStats;
}

function contentText(content: string | LLMContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content.map(block => (block.type === 'text' ? block.text : '')).join('');
}

function messageTokens(message: CompiledMessage, estimateTextTokens: (text: string) => number): number {
    let tokens = estimateTextTokens(contentText(message.content));
    if (Array.isArray(message.content)) {
        // 图片块按固定开销估算（不依赖图片字节数）
        const images = message.content.filter(block => block.type !== 'text').length;
        tokens += images * 64;
    }
    if (message.role) tokens += 4;
    if (message.tool_calls) tokens += message.tool_calls.length * 8;
    if (message.reasoning_content) tokens += estimateTextTokens(message.reasoning_content);
    return tokens;
}

function toToolCalls(unit: ConversationUnit): { complete: boolean; calls: CompiledToolCall[]; missingNames: string[]; resultByCallId: Map<string, ConversationEvent[]> } {
    const calls: CompiledToolCall[] = [];
    const missingNames: string[] = [];
    const resultByCallId = new Map<string, ConversationEvent[]>();
    const callEvents = unit.events.filter(e => e.kind === 'tool_call');
    const resultEvents = unit.events.filter(e => e.kind === 'tool_result');

    for (const result of resultEvents) {
        const key = String((result as { callId?: unknown }).callId ?? '');
        if (!key) continue;
        const list = resultByCallId.get(key);
        if (list) list.push(result);
        else resultByCallId.set(key, [result]);
    }
    for (const call of callEvents) {
        const id = String((call as { callId?: unknown }).callId ?? '');
        const name = String((call as { name?: unknown }).name ?? '');
        const args = String((call as { args?: unknown }).args ?? '{}');
        if (id && resultByCallId.has(id)) {
            calls.push({ id, type: 'function', function: { name, arguments: args } });
        } else {
            missingNames.push(name || id || 'unknown-tool');
        }
    }
    return { complete: missingNames.length === 0, calls, missingNames, resultByCallId };
}

function userDisplay(options: CompileOptions, uid: string): string {
    try {
        return options.resolveUserName ? options.resolveUserName(uid) : uid;
    } catch {
        return uid;
    }
}

function fmtTime(options: CompileOptions, at: number): string {
    return options.formatTime ? options.formatTime(at) : String(at);
}

function fmtMsgId(options: CompileOptions, id: string): string {
    return options.formatMessageId ? options.formatMessageId(id) : id;
}

function seqOf(event: ConversationEvent): number {
    const seq = Number((event as { seq?: unknown }).seq);
    return Number.isFinite(seq) ? Math.floor(seq) : 0;
}

function dateKeyOf(options: CompileOptions, at: number): string {
    if (options.formatDateKey) return options.formatDateKey(at);
    if (options.formatTime) return options.formatTime(at).slice(0, 10);
    return String(at);
}

/** 消息事件：只有 user/assistant/system 参与标签与锚点；工具调用/结果不算消息 */
function isMessageEvent(event: ConversationEvent): boolean {
    return event.kind === 'user' || event.kind === 'assistant' || event.kind === 'event';
}

/** 标签决定：msgId=是否带 [msg_id]；time=是否带 [time] */
interface EventFlags {
    msgId: boolean;
    time: boolean;
}

interface TagDecisions {
    msgId: Set<number>;
    time: Set<number>;
    retainedTokens: number;
}

/**
 * 计算标签与时间锚点（纯函数）：
 * - 标签边界：从最新消息往回累计 token（含 system），最新一条 user/assistant 无条件带标签；
 *   超出边界的旧消息去 [msg_id]；
 * - user 在边界内带 [time]；边界外只在锚点带 [time]：首条未标记 user、静默≥1h、跨天、每 100 条消息。
 */
function computeTagDecisions(units: readonly ConversationUnit[], options: CompileOptions): TagDecisions {
    const msgId = new Set<number>();
    const time = new Set<number>();
    const boundary = options.tagBoundaryTokens;
    if (boundary === undefined) {
        // 旧行为：所有 user/assistant 全标签
        for (const unit of units) {
            for (const event of unit.events) {
                if (event.kind === 'user' || event.kind === 'assistant') msgId.add(seqOf(event));
            }
        }
        for (const unit of units) {
            for (const event of unit.events) {
                if (event.kind === 'user') time.add(seqOf(event));
            }
        }
        let retained = 0;
        for (const unit of units) for (const event of unit.events) if (isMessageEvent(event)) retained += Math.max(0, options.estimateEventTokens(event));
        return { msgId, time, retainedTokens: retained };
    }

    const limit = Number.isFinite(boundary) ? Math.max(0, Math.floor(boundary)) : 0;
    const messages: Array<{ event: ConversationEvent; tokens: number }> = [];
    for (const unit of units) {
        for (const event of unit.events) {
            if (!isMessageEvent(event)) continue;
            messages.push({ event, tokens: Math.max(0, options.estimateEventTokens(event)) });
        }
    }
    messages.sort((a, b) => seqOf(b.event) - seqOf(a.event));

    let retained = 0;
    if (limit > 0) {
        let forced = false;
        for (const item of messages) {
            if (item.event.kind === 'event') {
                // system 事件不参与 msg_id 标签，但按口径计入保留 token
                retained += item.tokens;
                continue;
            }
            if (!forced) {
                forced = true;
                msgId.add(seqOf(item.event));
                retained += item.tokens;
                continue;
            }
            if (retained + item.tokens > limit) break;
            msgId.add(seqOf(item.event));
            retained += item.tokens;
        }
    }

    // 时间决策：按渲染顺序（unit 升序，事件顺序）遍历
    let lastShownAt: number | null = null;
    let sinceMessages = 0;
    for (const unit of units) {
        for (const event of unit.events) {
            const at = Number((event as { at?: number }).at ?? 0);
            if (event.kind === 'event') {
                if (at > 0) {
                    time.add(seqOf(event));
                    lastShownAt = at;
                    sinceMessages = 0;
                }
                continue;
            }
            if (event.kind === 'assistant') {
                sinceMessages++;
                continue;
            }
            if (event.kind !== 'user') continue;
            if (msgId.has(seqOf(event))) {
                time.add(seqOf(event));
                if (at > 0) lastShownAt = at;
                sinceMessages = 0;
                continue;
            }
            const gap = lastShownAt !== null && at > 0 && at - lastShownAt >= TAG_ANCHOR_GAP_SEC;
            const dateChanged = lastShownAt !== null && at > 0 && dateKeyOf(options, at) !== dateKeyOf(options, lastShownAt);
            const anchor = lastShownAt === null || gap || dateChanged || sinceMessages >= TAG_ANCHOR_EVERY_MESSAGES;
            if (anchor && at > 0) {
                time.add(seqOf(event));
                lastShownAt = at;
                sinceMessages = 0;
            } else {
                sinceMessages++;
            }
        }
    }
    return { msgId, time, retainedTokens: retained };
}

/** 用户事件渲染：前缀按标签决定（from → time → msg_id）；保留图片内容块 */
function renderUserEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex, flags: EventFlags): CompiledMessage {
    const user = event as unknown as { uid?: string; at?: number; msgId?: string };
    const parts = applyEdit(event, index);
    const msgId = String(user.msgId ?? '');
    const at = Number(user.at ?? 0);
    let prefix = `[from:${userDisplay(options, String(user.uid ?? ''))}]`;
    if (flags.time && at > 0) prefix += `[time:${fmtTime(options, at)}]`;
    if (flags.msgId && msgId) prefix += `[msg_id:${fmtMsgId(options, msgId)}]`;
    const content = toLLM(parts, options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
    if (typeof content === 'string') return { role: 'user', content: prefix + content };
    return { role: 'user', content: [{ type: 'text', text: prefix }, ...content] };
}

function renderAssistantEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex, flags: EventFlags): CompiledMessage {
    const parts = applyEdit(event, index);
    // INV-8：assistant 消息不允许图片（API 明确 "Image in assistant message is not supported"）。
    // 即便历史数据/编辑注入了 image part，这里也只做纯文本投影，[img:<ref>] 标签保留。
    const base = toLLMText(parts, options.caps ?? {}, options.resolve ?? {});
    const msgId = String((event as { msgId?: string }).msgId ?? '');
    const prefix = flags.msgId && msgId ? `[msg_id:${fmtMsgId(options, msgId)}]` : '';
    const message: CompiledMessage = { role: 'assistant', content: prefix ? prefix + base : base };
    const reasoning = (event as { reasoning?: string }).reasoning;
    if (reasoning !== undefined) message.reasoning_content = reasoning;
    return message;
}

function renderSystemEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex): CompiledMessage {
    const e = event as unknown as { systemName?: string; eventType?: string; parts?: Part[]; raw?: unknown; at?: number };
    const name = e.systemName || SYSTEM_NAME.event;
    const text = toLLMText(applyEdit(event, index), options.caps ?? {}, options.resolve ?? {});
    const at = Number(e.at ?? 0);
    const time = at > 0 ? `[time:${fmtTime(options, at)}]` : '';
    return { role: 'user', content: `[system:${name}]${time}${text ? ' ' + text : ''} [/system]` };
}

/** 工具结果边界：native 与提示词工程统一为 [tool_result:name-or-id]…[/tool_result] */
function wrapToolResult(label: string, content: string | LLMContentBlock[]): string | LLMContentBlock[] {
    const head = toolResultHeader(label) + '\n';
    const tail = '\n' + TOOL_RESULT_CLOSE;
    if (typeof content === 'string') return head + content + tail;
    return [{ type: 'text', text: head }, ...content, { type: 'text', text: tail }];
}

/** 渲染工具组：native=assistant tool_calls + tool 消息；PE=函数块 + 用户文本 */
function renderToolGroup(unit: ConversationUnit, options: CompileOptions, index: RecordIndex): CompiledMessage[] {
    const { calls, missingNames, resultByCallId } = toToolCalls(unit);
    const mode = options.mode ?? 'native';
    if (mode === 'prompt-engineering') {
        const lines: string[] = [];
        for (const call of calls) {
            lines.push('```function');
            lines.push(JSON.stringify({ name: call.function.name, arguments: call.function.arguments }));
            lines.push('```');
        }
        for (const name of missingNames) lines.push(`Tool ${name}: call unfinished (no result)`);
        const out: CompiledMessage[] = [{ role: 'assistant', content: lines.join('\n') }];
        for (const [callId, results] of resultByCallId) {
            const name = calls.find(c => c.id === callId)?.function.name ?? '';
            for (const result of results) {
                const text = toLLMText(applyEdit(result, index), options.caps ?? {}, options.resolve ?? {});
                out.push({ role: 'user', content: wrapToolResult(name || callId, text) as string });
            }
        }
        return out;
    }

    const out: CompiledMessage[] = [];
    const contentParts: string[] = [];
    if (missingNames.length > 0) contentParts.push(`Unfinished tool calls (no result): ${missingNames.join(', ')}`);
    const assistant: CompiledMessage = {
        role: 'assistant',
        content: contentParts.join('\n'),
    };
    if (calls.length > 0) assistant.tool_calls = calls;
    const reasoning = unit.events.find(e => e.kind === 'tool_call' && (e as { reasoning?: string }).reasoning !== undefined) as { reasoning?: string } | undefined;
    if (reasoning?.reasoning !== undefined) assistant.reasoning_content = reasoning.reasoning;
    // 没有任何可回放调用、也没有调用说明时不产生空 assistant 消息
    if (calls.length > 0 || contentParts.length > 0) out.push(assistant);
    for (const call of calls) {
        const results = resultByCallId.get(call.id) ?? [];
        for (const result of results) {
            const resultParts = applyEdit(result, index);
            // INV-12：tool 图片可按配置关闭（部分网关不支持 tool 角色带图），关闭时纯文本投影
            const content = options.toolImages === false
                ? toLLMText(resultParts, options.caps ?? {}, options.resolve ?? {})
                : toLLM(resultParts, options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
            out.push({ role: 'tool', tool_call_id: call.id, content: wrapToolResult(call.id, content) });
        }
    }
    return out;
}

function renderOrphanResult(unit: ConversationUnit, options: CompileOptions, index: RecordIndex): CompiledMessage[] {
    const out: CompiledMessage[] = [];
    for (const event of unit.events) {
        const text = toLLMText(applyEdit(event, index), options.caps ?? {}, options.resolve ?? {});
        const name = String((event as { name?: unknown }).name ?? '')
            || String((event as { callId?: unknown }).callId ?? '');
        out.push({ role: 'user', content: wrapToolResult(name, text) as string });
    }
    return out;
}

function renderUserUnit(unit: ConversationUnit, options: CompileOptions, index: RecordIndex, decisions: TagDecisions): CompiledMessage[] {
    const rendered = unit.events.map(event => renderUserEvent(event, options, index, {
        msgId: decisions.msgId.has(seqOf(event)),
        time: decisions.time.has(seqOf(event)),
    }));
    if (rendered.length === 0) return [];
    if (rendered.length === 1) return rendered;
    const blocks: LLMContentBlock[] = [];
    rendered.forEach((message, i) => {
        if (i > 0) blocks.push({ type: 'text', text: '\n' });
        if (typeof message.content === 'string') blocks.push({ type: 'text', text: message.content });
        else blocks.push(...message.content);
    });
    const allText = blocks.every(block => block.type === 'text');
    return [{
        role: 'user',
        content: allText
            ? blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
            : blocks,
    }];
}

function renderUnit(unit: ConversationUnit, options: CompileOptions, index: RecordIndex, decisions: TagDecisions): CompiledMessage[] {
    if (unit.kind === 'tool_group') return renderToolGroup(unit, options, index);
    if (unit.kind === 'orphan_result') return renderOrphanResult(unit, options, index);
    if (unit.kind === 'user') return renderUserUnit(unit, options, index, decisions);
    const out: CompiledMessage[] = [];
    for (const event of unit.events) {
        if (event.kind === 'user') out.push(renderUserEvent(event, options, index, {
            msgId: decisions.msgId.has(seqOf(event)),
            time: decisions.time.has(seqOf(event)),
        }));
        else if (event.kind === 'assistant') out.push(renderAssistantEvent(event, options, index, {
            msgId: decisions.msgId.has(seqOf(event)),
            time: decisions.time.has(seqOf(event)),
        }));
        else out.push(renderSystemEvent(event, options, index));
    }
    return out;
}

/** 按字符上限截断一个事件的文本 parts（头 2/3 + 尾 1/3 + 指针）；图片等非文本 part 保留 */
function truncateEventParts(event: ConversationEvent, maxChars: number, readFrom: number, readTo: number): ConversationEvent {
    const parts = (event as { parts?: Part[] }).parts;
    if (!Array.isArray(parts) || maxChars <= 0) return event;
    const textParts = parts.filter(p => p.type === 'text') as Array<{ type: 'text'; text: string }>;
    const totalChars = textParts.reduce((n, p) => n + p.text.length, 0);
    if (totalChars <= maxChars) return event;
    const head = Math.floor(maxChars * 2 / 3);
    const tail = Math.max(0, maxChars - head);
    let remainingHead = head;
    let remainingTail = tail;
    const nextParts: Part[] = parts.map(part => {
        if (part.type !== 'text') return part;
        const text = part.text;
        const takeHead = Math.min(text.length, remainingHead);
        remainingHead -= takeHead;
        const rest = text.slice(takeHead);
        const takeTail = Math.min(rest.length, remainingTail);
        remainingTail -= takeTail;
        const kept = text.slice(0, takeHead) + (rest.length > takeTail ? '…' : '') + (takeTail > 0 ? text.slice(text.length - takeTail) : '');
        return { type: 'text', text: kept };
    });
    nextParts.push({
        type: 'text',
        text: buildEventRangeTruncateMarker(totalChars, head + tail, readFrom, readTo),
    });
    return { ...(event as object), parts: nextParts } as ConversationEvent;
}

function truncateUnit(unit: ConversationUnit, availableTokens: number): ConversationUnit {
    if (availableTokens < 0) availableTokens = 0;
    const maxChars = Math.max(80, Math.floor(availableTokens * 3));
    const each = Math.max(60, Math.floor(maxChars / Math.max(1, unit.events.length)));
    const events = unit.events.map(event => truncateEventParts(event, each, event.seq, event.seq));
    return { ...unit, events };
}

/** 摘要区间是否与 edit/redact 相交：相交时摘要文本可能过期，回退旧行为（原文优先，摘要只作预算兜底） */
function summaryIsStale(index: RecordIndex, summary: SummaryRecord): boolean {
    for (const seq of index.edits.keys()) {
        if (seq >= summary.fromSeq && seq <= summary.toSeq) return true;
    }
    for (const redact of index.redacts) {
        if (redact.toSeq >= summary.fromSeq && redact.fromSeq <= summary.toSeq) return true;
    }
    return false;
}

/** 组装当前 epoch 摘要的注入块（带硬上限与时间范围）；无可用摘要返回 null */
function buildSummaryBlock(options: CompileOptions, summary: SummaryRecord): { text: string; tokens: number } | null {
    const maxChars = options.summaryMaxChars ?? SUMMARY_MAX_CHARS;
    const body = summary.text.length > maxChars ? summary.text.slice(0, maxChars) + '…' : summary.text;
    const fromAt = Number(summary.fromAt ?? 0);
    const toAt = Number(summary.toAt ?? 0);
    const timeRange = fromAt > 0 && toAt > 0 ? `${fmtTime(options, fromAt)} ~ ${fmtTime(options, toAt)}` : undefined;
    const text = earlierSummaryBlock(body, summary.fromSeq, summary.toSeq, timeRange);
    return { text, tokens: options.estimateTextTokens(text) + 8 };
}

/**
 * 编译请求：唯一决定本轮请求体的纯函数。
 * 调用方负责：构建 prefixMessages（system/预设）、传入预算与能力/估算。
 */
export function compileRequest(options: CompileOptions): CompileResult {
    const estimateText = options.estimateTextTokens;
    const estimateEvent = options.estimateEventTokens;
    const prefix = options.prefixMessages ? options.prefixMessages.slice() : [];
    const prefixTokens = options.prefixTokens ?? prefix.reduce((n, m) => n + messageTokens(m, estimateText), 0);
    const toolsReserve = Math.max(0, options.toolsReserveTokens ?? 0);
    const available = Math.max(0, options.budgetTokens - prefixTokens - toolsReserve);

    const index = buildRecordIndex(options.snapshot.records);
    const visible = applyVisibility(options.snapshot.events, index);
    const allUnits = segmentUnits(visible);

    // 摘要边界（单元感知：工具组可能晚到，不能按事件 seq 细切）
    const latest = latestSummary(index, Number.MAX_SAFE_INTEGER);
    const stale = latest ? summaryIsStale(index, latest) : false;
    let summary: SummaryRecord | null = null;
    let summaryBoundarySeq = 0;
    let units = allUnits;
    if (latest && !stale && latest.toSeq >= index.epochStartSeq) {
        const filtered = allUnits.filter(unit => unit.toSeq > latest.toSeq);
        if (filtered.length > 0) {
            units = filtered;
            summary = latest;
            summaryBoundarySeq = latest.toSeq;
        }
        // 防御：过滤后为空（脏数据/摘要覆盖到最新）→ 保持旧行为，不隐藏任何内容
    }

    const selected: ConversationUnit[] = [];
    let used = 0;
    let truncated = false;
    for (let i = units.length - 1; i >= 0; i--) {
        const unit = units[i];
        const tokens = estimateUnitTokens(unit, estimateEvent);
        if (selected.length === 0) {
            if (tokens > available) {
                selected.push(truncateUnit(unit, available));
                truncated = true;
                used += Math.min(tokens, available);
            } else {
                selected.push(unit);
                used += tokens;
            }
            continue;
        }
        if (used + tokens > available) break;
        selected.push(unit);
        used += tokens;
    }
    selected.reverse();

    const firstSelected = (): number => (selected.length > 0 ? Math.min(...selected.map(u => u.fromSeq)) : 0);

    // 摘要/缺口注入占预算：放不下时从最旧选中单元开始让位（摘要本身不能被静默丢弃）
    const summaryBlock = summary ? buildSummaryBlock(options, summary) : null;
    const buildGap = (firstSeq: number): { text: string; tokens: number; from: number; to: number } | null => {
        if (selected.length === 0) return null;
        let from: number;
        if (summary) from = summaryBoundarySeq + 1;
        else from = index.epochStartSeq;
        const to = firstSeq - 1;
        if (to < from) return null;
        const text = earlierSummaryGapText(to - from + 1, from, to);
        return { text, tokens: estimateText(text) + 8, from, to };
    };
    while (selected.length > 1 && summaryBlock) {
        const gap = buildGap(firstSelected());
        const extra = summaryBlock.tokens + (gap ? gap.tokens : 0);
        if (used + extra <= available) break;
        const removed = selected.shift()!;
        used = Math.max(0, used - estimateUnitTokens(removed, estimateEvent));
    }

    const firstSeq = firstSelected();
    const gap = buildGap(firstSeq);
    // stale 摘要（区间与 edit/redact 相交）回退旧行为时，不把缺口当作「预算到顶」触发压缩：
    // 否则每轮都会触发一次压缩，而摘要文本无法被安全重算（X3 TODO），形成无效循环。
    const triggerOmitted = stale ? null : gap;
    const stats: CompileStats = {
        unitsTotal: units.length,
        unitsSelected: selected.length,
        firstSelectedSeq: firstSeq,
        lastSelectedSeq: selected.length > 0 ? Math.max(...selected.map(u => u.toSeq)) : 0,
        estimatedTokens: used,
        truncated,
        summaryInjected: false,
        gapInjected: false,
        summaryBoundarySeq: summary ? summaryBoundarySeq : 0,
        summaryStale: stale,
        omittedFromSeq: triggerOmitted ? triggerOmitted.from : null,
        omittedToSeq: triggerOmitted ? triggerOmitted.to : null,
        retainedTokens: 0,
        taggedMessages: 0,
    };

    const decisions = computeTagDecisions(selected, options);
    stats.retainedTokens = decisions.retainedTokens;
    stats.taggedMessages = decisions.msgId.size;

    const messages: CompiledMessage[] = prefix.slice();
    if (summaryBlock) {
        messages.push({ role: 'user', content: summaryBlock.text });
        stats.summaryInjected = true;
    }
    if (gap && summaryBlock) {
        // 有摘要但摘要与窗口之间仍有未摘要区（压缩滞后/预算裁剪）
        messages.push({ role: 'user', content: gap.text });
        stats.gapInjected = true;
    } else if (gap && !summaryBlock) {
        // 无摘要（或 stale 回退）：更早内容未摘要，明确提示可回查
        messages.push({ role: 'user', content: gap.text });
        stats.gapInjected = true;
    }

    for (const unit of selected) {
        for (const message of renderUnit(unit, options, index, decisions)) messages.push(message);
    }

    return { messages, stats };
}

/** 便捷包装：取指定 seq 的展示 parts（给投影/调试用；空记录索引） */
export function eventDisplayParts(event: ConversationEvent): Part[] {
    return applyEdit(event, buildRecordIndex([]));
}

/** 便捷包装：当前 epoch 的最新 rolling summary（供 .ai ctx/调试展示） */
export function currentSummary(snapshot: ContextSnapshot): SummaryRecord | null {
    const index = buildRecordIndex(snapshot.records);
    return latestSummary(index, Number.MAX_SAFE_INTEGER);
}

/** 文本内容规范化（给测试/投影用） */
export function compiledContentText(message: CompiledMessage): string {
    return contentText(message.content);
}

/** 渲染文本（给测试/调试用） */
export function partsText(parts: Part[]): string {
    return renderText(parts);
}
