// Context v2 请求编译器（纯函数）：唯一决定"本轮给模型看什么"的地方。
//
// 输入：store 快照（事件 + 记录 + head）、已构建好的前缀消息（system/预设）、预算与能力。
// 输出：OpenAI 兼容消息数组（provider 层再做方言转换）。
//
// 规则（对应设计 INV-A/B/C）：
// - 单元从新到旧选择；**最新单元必留**；预算不够时截断最新单元的文本并带 read_raw 指针；
// - 工具组整组选择；不完整组降级为文本，不产生无结果的 tool_calls；
// - 被省略的区间：注入 rolling summary；没有摘要则显式提示缺口（绝不静默）；
// - 纯函数：不读 Config/seal/storage，时间/名字/估算全部注入，便于单测与 goldens。
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
    summaryGap,
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
}

export interface CompileResult {
    messages: CompiledMessage[];
    stats: CompileStats;
}

const DEFAULT_SUMMARY_MAX_CHARS = 4000;

/** 本地内容块类型别名，避免编译器依赖 provider 协议层 */
type ContentBlock = LLMContentBlock;

function contentText(content: string | ContentBlock[]): string {
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

/** 用户事件渲染：前缀（from/time/msg_id）+ 内容投影；保留图片内容块 */
function renderUserEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex): CompiledMessage {
    const user = event as unknown as { uid?: string; at?: number; msgId?: string };
    const parts = applyEdit(event, index);
    const msgId = String(user.msgId ?? '');
    const prefix = `[from:${userDisplay(options, String(user.uid ?? ''))}][time:${fmtTime(options, Number(user.at ?? 0))}]`
        + (msgId ? `[msg_id:${fmtMsgId(options, msgId)}]` : '');
    const content = toLLM(parts, options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
    if (typeof content === 'string') return { role: 'user', content: prefix + content };
    return { role: 'user', content: [{ type: 'text', text: prefix }, ...content] };
}

function renderAssistantEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex): CompiledMessage {
    const parts = applyEdit(event, index);
    const base = toLLM(parts, options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
    const msgId = String((event as { msgId?: string }).msgId ?? '');
    const prefix = msgId ? `[msg_id:${fmtMsgId(options, msgId)}]` : '';
    const content = prefix
        ? (typeof base === 'string' ? prefix + base : [{ type: 'text' as const, text: prefix }, ...base])
        : base;
    const message: CompiledMessage = { role: 'assistant', content };
    const reasoning = (event as { reasoning?: string }).reasoning;
    if (reasoning !== undefined) message.reasoning_content = reasoning;
    return message;
}

function renderSystemEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex): CompiledMessage {
    const e = event as unknown as { systemName?: string; eventType?: string; parts?: Part[]; raw?: unknown; at?: number };
    const name = e.systemName || SYSTEM_NAME.event;
    const text = toLLMText(applyEdit(event, index), options.caps ?? {}, options.resolve ?? {});
    const time = Number(e.at ?? 0) > 0 ? `[time:${fmtTime(options, Number(e.at))}]` : '';
    return { role: 'user', content: `[system:${name}]${time}${text ? ' ' + text : ''} [/system]` };
}

/** 工具结果边界：native 与提示词工程统一为 [tool_result:name-or-id]…[/tool_result] */
function wrapToolResult(label: string, content: string | ContentBlock[]): string | ContentBlock[] {
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
            const content = toLLM(applyEdit(result, index), options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
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

function renderUserUnit(unit: ConversationUnit, options: CompileOptions, index: RecordIndex): CompiledMessage[] {
    const rendered = unit.events.map(event => renderUserEvent(event, options, index));
    if (rendered.length === 0) return [];
    if (rendered.length === 1) return rendered;
    const blocks: ContentBlock[] = [];
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

function renderUnit(unit: ConversationUnit, options: CompileOptions, index: RecordIndex): CompiledMessage[] {
    if (unit.kind === 'tool_group') return renderToolGroup(unit, options, index);
    if (unit.kind === 'orphan_result') return renderOrphanResult(unit, options, index);
    if (unit.kind === 'user') return renderUserUnit(unit, options, index);
    const out: CompiledMessage[] = [];
    for (const event of unit.events) {
        if (event.kind === 'user') out.push(renderUserEvent(event, options, index));
        else if (event.kind === 'assistant') out.push(renderAssistantEvent(event, options, index));
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
    const units = segmentUnits(visible);

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

    // 摘要注入也占预算：有摘要可注入时，从最旧单元开始让位；无摘要的缺口提示不挤占数据。
    const maxSummaryChars = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    while (selected.length > 1) {
        const firstSeq = Math.min(...selected.map(u => u.fromSeq));
        const gap = summaryGap(index, firstSeq);
        if (!gap.summary) break;
        const text = gap.summary.text.length > maxSummaryChars
            ? gap.summary.text.slice(0, maxSummaryChars) + '…'
            : gap.summary.text;
        const summaryTokens = estimateText(earlierSummaryBlock(text, gap.summary.fromSeq, gap.summary.toSeq)) + 8;
        if (used + summaryTokens <= available) break;
        const removed = selected.shift()!;
        used = Math.max(0, used - estimateUnitTokens(removed, estimateEvent));
    }

    const stats: CompileStats = {
        unitsTotal: units.length,
        unitsSelected: selected.length,
        firstSelectedSeq: selected.length > 0 ? Math.min(...selected.map(u => u.fromSeq)) : 0,
        lastSelectedSeq: selected.length > 0 ? Math.max(...selected.map(u => u.toSeq)) : 0,
        estimatedTokens: used,
        truncated,
        summaryInjected: false,
        gapInjected: false,
    };

    const messages: CompiledMessage[] = prefix.slice();

    // 省略区间：摘要 / 显式缺口提示
    if (selected.length > 0) {
        const firstSeq = stats.firstSelectedSeq;
        const gap = summaryGap(index, firstSeq);
        const hasSkipped = gap.skippedToSeq >= gap.skippedFromSeq;
        if (hasSkipped) {
            const summary: SummaryRecord | null = gap.summary;
            const maxChars = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
            if (summary) {
                const text = summary.text.length > maxChars ? summary.text.slice(0, maxChars) + '…' : summary.text;
                messages.push({
                    role: 'user',
                    content: earlierSummaryBlock(text, summary.fromSeq, summary.toSeq),
                });
                stats.summaryInjected = true;
            }
            if (gap.hasGap) {
                const from = gap.uncoveredFromSeq ?? gap.skippedFromSeq;
                const to = gap.uncoveredToSeq ?? gap.skippedToSeq;
                messages.push({
                    role: 'user',
                    content: earlierSummaryGapText(to - from + 1, from, to),
                });
                stats.gapInjected = true;
            }
        }
    }

    for (const unit of selected) {
        for (const message of renderUnit(unit, options, index)) messages.push(message);
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
