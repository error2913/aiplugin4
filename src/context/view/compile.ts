// Context v2 请求编译器（纯函数）：唯一决定"本轮给模型看什么"的地方。
//
// 输入：store 快照（事件 + 记录 + head）、已构建好的前缀消息（system/预设）、预算与能力。
// 输出：OpenAI 兼容消息数组（provider 层再做方言转换）。
//
// #163（前缀缓存稳定性）后的核心契约 —— **历史层渲染是「事件内冻结字段 + 已发送水位」的纯函数**：
// - **全量渲染可见单元**：没有任何"按本轮预算选子集"的路径。删掉选择器的原因是它让同一段
//   历史的渲染形态随可用预算抖动（预算降一点就从历史中间丢一条）⇒ 已发送前缀的字节被改写
//   （R1 破裂，代价从断点起一直到请求体末尾）。预算不足一律交给**归档**（`stats.needsArchive`
//   仅作观测/兜底；真正兜底是请求超长后的 `context_too_long` → 归档 → 重发）。
// - **历史不带 `[msg_id]` / `[time]`**：两者都会随窗口位置漂移。`[from]` 保留，但只在**写入时**
//   取一次显示名（`UserEvent.fromName`）后冻结；旧数据缺字段时回落活名（不回填历史页）。
// - **`renderSystemEvent` 的 `[time]` 是唯一保留的时间标签**：`at` 是写入时冻结值，仍是前缀函数，
//   且 wake / 未即时轮次需要"现在"这个锚点（REQ-D4-06）。
// - **工具组结算后整组渲染**：未结算组（缺结果且之后没有更晚的对话事件）本轮不进渲染 ——
//   否则结果晚到会把"调用未完成"文本改写成真实 tool 消息，改写已发送区。
// - **单元边界随发送冻结**：`segmentUnits(..., { anchorSeq })` 让跨 anchor 的相邻 user 不合并。
// - **冻结守卫**（REQ-D2-16）：传入上轮快照时比对，已发送前缀若在无 rebase 的情况下变了 ⇒
//   记 `stats.prefixDrift` 并用快照覆盖冻结区，同时由调用方记一次 `prefix-drift-freeze` rebase。
// - 纯函数：不读 Config/seal/storage，时间/名字/估算全部注入，便于单测与 goldens。
import {
    HISTORY_EVENT_MAX_TOKENS,
    SUMMARY_MAX_CHARS,
} from "../../utils/context_limits";
import {
    buildEventRangeTruncateMarker,
    buildToolTruncateMarkerV2,
    earlierSummaryBlock,
    earlierSummaryGapText,
    SYSTEM_NAME,
    TOOL_RESULT_CLOSE,
    toolResultHeader,
} from "../../utils/protocol";
import { truncateToTokenBudget } from "../../utils/token_budget";
import type { LLMCaps, MediaResolvers } from "../content/descriptors";
import type { LLMContentBlock, LLMDialect } from "../content/llm";
import { toLLM, toLLMText } from "../content/llm";
import { renderText } from "../content/render";
import type { ConversationEvent, Part, SummaryRecord } from "../events";
import { activeInjectTokens, compareBlocks, isStaleByRecords, releaseBoundaryOf, slot, splitInjections } from "../injections";
import type { InjectionRef } from "../injections";
import type { ContextSnapshot } from "../store";

import {
    applyEdit,
    applyVisibility,
    buildRecordIndex,
    latestSummary,
    RecordIndex,
} from "./records";
import type { ConversationUnit } from "./units";
import {
    estimateUnitTokens,
    segmentUnits,
    sliceAtAnchor,
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
     * 本轮已发送边界（上次编译的 `lastSelectedSeq`；#163 REQ-D2-12）。
     *
     * 用途一：`segmentUnits(..., { anchorSeq })` 让跨 anchor 的相邻 user 事件不合并
     * （合并会让下一轮新增消息改写已发送区）。
     * 用途二：`sliceAtAnchor` 算出冻结区，供冻结守卫定位"已发送前缀"。
     */
    anchorSeq?: number;
    /**
     * 上一轮编译产物快照（#163 REQ-D2-16 冻结守卫）。
     *
     * 传了才启用守卫：把本轮渲染结果与快照比对，若已发送前缀变了 ⇒ `stats.prefixDrift`
     * 记录首个差异下标，并用快照覆盖冻结区（宁可偏离本轮渲染，也不破坏缓存前缀）。
     * 不传（首轮 / 重载后 / 无会话）= 不启用，零成本。
     */
    prefixSnapshot?: { messages: readonly string[]; throughSeq: number };
    /** 必填：文本 token 估算（仓库内用 estimateTextTokens） */
    estimateTextTokens: (text: string) => number;
    /** 必填：单事件 token 估算（应包含 role/parts/tool_calls 口径） */
    estimateEventTokens: (event: ConversationEvent) => number;
    /** 注入的展示格式化钩子（避免编译器依赖 Config/User/日期格式） */
    resolveUserName?: (uid: string) => string;
    /** 时间格式化（摘要块的时间范围用；历史消息不再渲染 `[time]`） */
    formatTime?: (at: number) => string;
    /** 单个 summary 注入文本的硬上限（字符），防止摘要本身撑爆预算 */
    summaryMaxChars?: number;
    /**
     * 单条工具结果展示的 token 上限（0/缺省=不截断）。
     * 超过时只展示开头并追加 `[tool-output-truncated: N tokens, …; read_raw id=e:<seq>]`，
     * 完整原文仍在事件账本里（INV-R）；估算口径同样按截断后计算，避免超大工具结果被整组丢弃。
     */
    toolResultMaxTokens?: number;
}

export interface CompileStats {
    unitsTotal: number;
    /**
     * 实际渲染的单元数（#163 D2 起**恒等于 `unitsTotal`**）。
     *
     * 保留字段是为了让 D9 观测/`.ai ctx` 与既有单测有稳定口径：过去它表示"预算装下了几个"，
     * 现在全量渲染，它的值不再随预算变化 —— 这正是 R2（幂等重编译）的可见证据。
     */
    unitsRendered: number;
    firstSelectedSeq: number;
    /** D3 的 `lastSentSeq` 权威：本次编译覆盖到的最大 seq（全量渲染后 = 最后一个单元 toSeq） */
    lastSelectedSeq: number;
    estimatedTokens: number;
    /** 渲染总量超过 `available`（**仅观测/兜底**，不再驱动裁剪；真正兜底是 context_too_long → 归档） */
    needsArchive: boolean;
    summaryInjected: boolean;
    gapInjected: boolean;
    /** 当前 epoch 有效滚动摘要覆盖到的 seq（0=没有可用摘要 / 因 stale 回退） */
    summaryBoundarySeq: number;
    /** 摘要区间与 edit/redact 相交，本轮回退为旧行为（不按摘要边界裁剪） */
    summaryStale: boolean;
    /** 可见性边界过滤后为空（脏数据下"绝不重现全量"，只做观测；#163 REQ-D2-13） */
    boundaryDefense: boolean;
    /** 冻结守卫捕获的首个差异消息下标（undefined = 无漂移；#163 REQ-D2-16） */
    prefixDrift?: number;
    /** 本轮渲染的活跃注入块数量（#163 D9 观测） */
    injectionBlocks: number;
    /** 本轮注入块占用的 token（`available` 已扣除；#163 REQ-D3-31 公式 2） */
    injectionTokens: number;
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

/**
 * `[from:...]` 的显示名（#163 REQ-D2-04/05），三级回落链：
 * 1. `event.fromName`（**写入时冻结**的名字，随事件落盘）⇒ 改名不影响已发送历史；
 * 2. `options.resolveUserName(uid)`（旧数据没有 `fromName` 时的活名回落，实现见
 *    `utils/message.ts` 的 `compileV2Request`，那里读的是用户表的当前昵称）；
 * 3. 裸 `uid`（连记录都没有）。
 *
 * 第 2 级是**已知的**旧数据前缀不纯点：旧消息改名后 `[from]` 会变一次。这是 §G② 明示接受的
 * 权衡 —— 回填历史页会破坏 append-only 红线（`需求方案 §11.3`），而"旧数据改名即变一次"
 * 与改造前行为一致，没有变差。新写入的事件走第 1 级，永不漂移。
 */
function userDisplay(options: CompileOptions, event: ConversationEvent): string {
    const raw = event as unknown as { uid?: unknown; fromName?: unknown };
    const uid = String(raw.uid ?? '');
    const number = uid.replace(/^.+:/, '');
    const frozen = typeof raw.fromName === 'string' ? raw.fromName : '';
    if (frozen) return `${frozen}(${number})`;
    try {
        return options.resolveUserName ? options.resolveUserName(uid) : uid;
    } catch {
        return uid;
    }
}

function fmtTime(options: CompileOptions, at: number): string {
    return options.formatTime ? options.formatTime(at) : String(at);
}

// 说明：#163 D2（PR-09）删除了整段「标签分级」逻辑（`EventFlags` / `TagDecisions` /
// `computeTagDecisions` / `dateKeyOf` / `isMessageEvent` / `seqOf`）。
//
// 为什么整段删而不是"保留但关掉"：标签分级的作用是"越旧的消息越少标签"（省 token），
// 它按**从最新往回累加预算**决定边界 ⇒ 同一段历史的标签会随本轮窗口整体平移 ⇒ 已发送区
// 中间的字节被改写（断点之后全部作废，代价 ≈ 半个请求体）。省下的那点 token 远不值。
// 现在：历史一律不带 `[msg_id]` / `[time]`，模型定位历史走 `grep_raw`/`read_raw`（D5），
// 时间走 `kind:'time'` 注入块 + `get_time` 工具 + `renderSystemEvent` 的 `[time]`（D4）。

/**
 * 用户事件渲染：前缀 = `[from:<冻结名>(<号码>)]` +（引用事件时）`[quote_of:<msgId>]`，保留图片内容块。
 *
 * **没有任何随轮次变化的成分**：
 * - 名字来自 `event.fromName`（写入时冻结），缺字段时回落活名（旧数据不回填，REQ-D2-05）；
 * - 不复现 `[time]`/`[msg_id]`（REQ-D2-01/02）；
 * - `[quote_of:]` 是 `event.quoteOf` 字段直出（#163 REQ-D6-05/09），**不受**任何 msg_id 门控 ——
 *   它是"这条消息引用了谁"的语义标签，不是可选的展示装饰。
 */
function renderUserEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex): CompiledMessage {
    const parts = applyEdit(event, index);
    const quoteOf = (event as { quoteOf?: unknown }).quoteOf;
    let prefix = `[from:${userDisplay(options, event)}]`;
    if (typeof quoteOf === 'string' && quoteOf) prefix += `[quote_of:${quoteOf}]`;
    const content = toLLM(parts, options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
    if (typeof content === 'string') return { role: 'user', content: prefix + content };
    return { role: 'user', content: [{ type: 'text', text: prefix }, ...content] };
}

function renderAssistantEvent(event: ConversationEvent, options: CompileOptions, index: RecordIndex): CompiledMessage {
    const parts = applyEdit(event, index);
    // INV-8：assistant 消息不允许图片（API 明确 "Image in assistant message is not supported"）。
    // 即便历史数据/编辑注入了 image part，这里也只做纯文本投影，[img:<ref>] 标签保留。
    const message: CompiledMessage = { role: 'assistant', content: toLLMText(parts, options.caps ?? {}, options.resolve ?? {}) };
    const reasoning = (event as { reasoning?: string }).reasoning;
    if (reasoning !== undefined) message.reasoning_content = reasoning;
    return message;
}

/**
 * 系统事件渲染（`kind:'event'`：wake / 未即时轮次等框架事件）。
 *
 * **这里的 `[time]` 是历史层唯一保留的时间标签**（#163 REQ-D2-02 的"删时间"只针对 user/assistant）：
 * - `at` 是写入时冻结的时间戳 ⇒ 同一事件每轮渲染字节相同，不破坏 R1；
 * - wake / 离线补偿类事件必须带"现在几点"，否则模型无法判断间隔（REQ-D4-06 明确保留）；
 * - 用户侧追问"现在时间"由 `kind:'time'` 注入块和 `get_time` 工具承担（D4）。
 */
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

/**
 * 单条工具结果按 token 上限截断（head-only，保留非文本块）。
 * 超过上限时末尾追加 `[tool-output-truncated: N tokens, first M shown; read_raw id=e:<seq>]`；
 * 上限缺省/0 或未超限时原样返回。
 */
function capToolResultParts(
    parts: Part[],
    maxTokens: number | undefined,
    estimateTextTokens: (text: string) => number,
    seq: number,
): Part[] {
    if (!maxTokens || maxTokens <= 0) return parts;
    const textParts = parts.filter(part => part.type === 'text') as Array<{ type: 'text'; text: string }>;
    if (textParts.length === 0) return parts;
    const fullText = textParts.map(part => part.text).join('');
    if (!fullText) return parts;
    const slice = truncateToTokenBudget(fullText, maxTokens, estimateTextTokens);
    if (!slice.truncated) return parts;
    // 头截断：按原文本块顺序吃掉保留的前缀，非文本块（图片等）原样保留
    const out: Part[] = [];
    let remaining = slice.text;
    for (const part of parts) {
        if (part.type !== 'text') {
            out.push(part);
            continue;
        }
        if (remaining.length === 0) continue;
        const take = Math.min(part.text.length, remaining.length);
        if (take > 0) out.push({ type: 'text', text: remaining.slice(0, take) } as Part);
        remaining = remaining.slice(take);
    }
    out.push({ type: 'text', text: buildToolTruncateMarkerV2(slice.totalTokens, slice.shownTokens, seq) } as Part);
    return out;
}

/** 估算口径：tool_result 先按同一上限截断再交给原 estimator，保证"显示得下就选得进" */
function capEventForEstimate(
    event: ConversationEvent,
    maxTokens: number,
    estimateTextTokens: (text: string) => number,
): ConversationEvent {
    if (event.kind !== 'tool_result') return event;
    const parts = (event as { parts?: Part[] }).parts;
    if (!Array.isArray(parts)) return event;
    return { ...(event as object), parts: capToolResultParts(parts, maxTokens, estimateTextTokens, event.seq) } as ConversationEvent;
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
                const cappedParts = capToolResultParts(applyEdit(result, index), options.toolResultMaxTokens, options.estimateTextTokens, result.seq);
                const text = toLLMText(cappedParts, options.caps ?? {}, options.resolve ?? {});
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
            const cappedParts = capToolResultParts(applyEdit(result, index), options.toolResultMaxTokens, options.estimateTextTokens, result.seq);
            // INV-12：tool 图片可按配置关闭（部分网关不支持 tool 角色带图），关闭时纯文本投影
            const content = options.toolImages === false
                ? toLLMText(cappedParts, options.caps ?? {}, options.resolve ?? {})
                : toLLM(cappedParts, options.caps ?? {}, options.dialect ?? 'openai', options.resolve ?? {});
            out.push({ role: 'tool', tool_call_id: call.id, content: wrapToolResult(call.id, content) });
        }
    }
    return out;
}

function renderOrphanResult(unit: ConversationUnit, options: CompileOptions, index: RecordIndex): CompiledMessage[] {
    const out: CompiledMessage[] = [];
    for (const event of unit.events) {
        const cappedParts = capToolResultParts(applyEdit(event, index), options.toolResultMaxTokens, options.estimateTextTokens, event.seq);
        const text = toLLMText(cappedParts, options.caps ?? {}, options.resolve ?? {});
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

/**
 * 单元渲染前的单事件截断（#163 REQ-D2-07）：超限事件按**固定常量** `HISTORY_EVENT_MAX_TOKENS`
 * 截断并带 `read_raw` 指针。
 *
 * 为什么必须与"本轮 available"无关：旧实现按 `availableTokens` 二分出保留字符数 ⇒ 同一事件在
 * 预算宽裕的轮次渲染全文、在预算紧张的轮次渲染截断版 ⇒ 已发送区的字节被改写（R1 破裂），
 * 而且会随每一轮的窗口抖动反复改写。固定常量后，同一事件在任何一轮渲染出的字节都相同。
 *
 * 代价：单条超大消息可能让请求超出模型窗口 ⇒ `context_too_long` → 归档 → 重发（`agent.handleModelError`），
 * 这是接受的设计（d2 REQ-D2-07 风险栏）。
 */
function capUnitForRender(
    unit: ConversationUnit,
    estimateEventTokens: (event: ConversationEvent) => number,
): ConversationUnit {
    let changed = false;
    const events = unit.events.map(event => {
        const parts = (event as { parts?: Part[] }).parts;
        if (!Array.isArray(parts)) return event;
        if (estimateEventTokens(event) <= HISTORY_EVENT_MAX_TOKENS) return event;
        changed = true;
        // 以字符上限近似 token 上限（估算函数对 CJK 约为 1 token/字符，对英文更省）：这里只要
        // "确定性"，精确到 token 与否不影响 R1 —— 关键是**同一事件每轮得到同一个上限**。
        const chars = tightenToEventCap(event, HISTORY_EVENT_MAX_TOKENS, estimateEventTokens);
        return truncateEventParts(event, chars, event.seq, event.seq);
    });
    return changed ? { ...unit, events } : unit;
}

/** 二分出"能让该事件落到 token 上限内"的保留字符数（纯函数，只依赖 event 内容） */
function tightenToEventCap(
    event: ConversationEvent,
    maxTokens: number,
    estimateEventTokens: (event: ConversationEvent) => number,
): number {
    const parts = (event as { parts?: Part[] }).parts;
    if (!Array.isArray(parts)) return 0;
    let maxChars = 0;
    for (const part of parts) {
        if (part.type === 'text') maxChars = Math.max(maxChars, part.text.length);
    }
    if (maxChars <= 0) return 0;
    let low = 1;
    let high = maxChars;
    let best = 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = truncateEventParts(event, mid, event.seq, event.seq);
        if (estimateEventTokens(candidate) <= maxTokens) {
            best = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best;
}

/** 摘要区间是否与 edit/redact 相交：相交时摘要文本可能过期，回退旧行为（原文优先，摘要只作预算兜底） */
export function summaryIsStale(index: RecordIndex, summary: SummaryRecord): boolean {
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
 *
 * 调用方负责：构建 `prefixMessages`（system/预设）、传入预算与能力/估算，
 * 以及**写回** `anchorSeq`/`prefixSnapshot`（`utils/message.ts` 的 `compileV2Request`）。
 *
 * 核心性质（#163 R1/R2/R3）：
 * - **R1 严格前缀扩展**：对同一 `anchorSeq` 与同一批事件，`messages` 的前 `prefixSnapshot.messages.length`
 *   条恒不变 —— 渲染只依赖事件内冻结字段；
 * - **R2 幂等重编译**：同一快照编译两次字节一致（无时钟、无活读、无预算裁剪）；
 * - **R3 归档是唯一 rebase 点**：`archivedThrough` 上移会让隐藏边界前移，这是设计允许的重建。
 */
export function compileRequest(options: CompileOptions): CompileResult {
    const estimateText = options.estimateTextTokens;
    // 工具结果按展示上限截断后再估算：显示与预算口径必须一致（否则会被当作"整组超预算"）。
    const toolResultMaxTokens = options.toolResultMaxTokens;
    const estimateEvent = toolResultMaxTokens && toolResultMaxTokens > 0
        ? (event: ConversationEvent) => options.estimateEventTokens(capEventForEstimate(event, toolResultMaxTokens, estimateText))
        : options.estimateEventTokens;
    const prefix = options.prefixMessages ? options.prefixMessages.slice() : [];
    const prefixTokens = options.prefixTokens ?? prefix.reduce((n, m) => n + messageTokens(m, estimateText), 0);
    const toolsReserve = Math.max(0, options.toolsReserveTokens ?? 0);

    const index = buildRecordIndex(options.snapshot.records);
    const visible = applyVisibility(options.snapshot.events, index);
    // #163 D3-14：注入块先于 segmentUnits 剔除 —— 它们永不进单元、永不进摘要、永不进 facts。
    // 释放水位 = max(summarizedThrough, archivedThrough)（与下面的 hiddenBoundarySeq 同口径）。
    const releaseBoundary = releaseBoundaryOf(options.snapshot.head);
    const injectionSplit = splitInjections(visible, releaseBoundary, {
        isStale: meta => isStaleByRecords(meta, index.redacts),
    });
    // #163 REQ-D2-12：传 anchorSeq ⇒ 跨 anchor 的相邻 user 不合并（单元边界随发送冻结）
    const allUnits = segmentUnits(injectionSplit.conversation, { anchorSeq: options.anchorSeq });

    // #163 REQ-D3-31 公式 2：注入块也占请求体预算。不减会让 available 高估
    // ⇒ 渲染出的历史比实际能装的多 ⇒ 请求体超 budgetTokens。
    const injectionTokens = activeInjectTokens(visible, options.snapshot.head);
    const available = Math.max(0, options.budgetTokens - prefixTokens - toolsReserve - injectionTokens);

    // 可见性边界（单元感知：工具组可能晚到，不能按事件 seq 细切）：
    // - 摘要边界：已摘要内容不再以原文出现；
    // - 归档边界：硬切/待机归档（可能没有摘要）也不再以原文出现。
    // 两者取较大值作为隐藏边界；摘要仍只负责注入文本，不改变可见性判定。
    const latest = latestSummary(index, Number.MAX_SAFE_INTEGER);
    const stale = latest ? summaryIsStale(index, latest) : false;
    let summary: SummaryRecord | null = null;
    let summaryBoundarySeq = 0;
    if (latest && !stale && latest.toSeq >= index.epochStartSeq) {
        summary = latest;
        summaryBoundarySeq = latest.toSeq;
    }
    const archRaw = Number(options.snapshot.head?.archivedThrough ?? 0);
    const archivedThrough = Number.isFinite(archRaw) ? Math.max(0, Math.floor(archRaw)) : 0;
    const hiddenBoundarySeq = Math.max(summaryBoundarySeq, archivedThrough);
    // #163 REQ-D2-13：**删掉"过滤后为空则回退全量"的防御**。
    // 那条防御会让脏数据（archivedThrough 越过最新）把已归档内容重新渲染出来 —— 等于凭空往前
    // 插入一大段历史，前缀直接崩掉。现在宁可渲染空历史（只标 stats.boundaryDefense 供观测），
    // 也绝不回退全量。`normalizeHead` 已夹断 archivedThrough ≤ nextSeq-1，实际不可达。
    const units = hiddenBoundarySeq > 0
        ? allUnits.filter(unit => unit.toSeq > hiddenBoundarySeq)
        : allUnits;
    const boundaryDefense = hiddenBoundarySeq > 0 && units.length === 0;

    // #163 REQ-D2-09：未结算的工具组本轮**不渲染**。
    //
    // 为什么：未结算组的渲染形态会随"结果晚到"变化（先是"调用未完成"文本，结果到齐后变成
    // 真实 tool 消息）。若已发送区出现过前者，后者就把那一段改写了（R1 破裂）。不渲染则是安全的：
    // 调用事件是在模型响应之后才 append 的，其 seq 必然 > 上轮已发送末尾 ⇒ 结算后它作为**新单元**
    // 追加在尾部，仍是严格前缀扩展。
    const renderUnits = units.filter(unit => unit.kind !== 'tool_group' || unit.settled !== false);

    // #163 REQ-D2-10：删除"从最新往回累加选择"，改为**全量渲染**。
    // 只做与预算无关的固定上限截断（REQ-D2-07），保证同一事件每轮渲染字节相同。
    const rendered = renderUnits.map(unit => capUnitForRender(unit, estimateEvent));

    const estimateRendered = (): number => {
        let total = 0;
        for (const unit of rendered) total += estimateUnitTokens(unit, estimateEvent);
        return total;
    };
    const used = estimateRendered();

    const firstSelected = (): number => {
        if (rendered.length > 0) return Math.min(...rendered.map(u => u.fromSeq));
        return 0;
    };
    const lastSelected = (): number => {
        let max = 0;
        for (const unit of rendered) if (unit.toSeq > max) max = unit.toSeq;
        return max;
    };

    // 摘要/缺口：摘要文本占预算，但**不再让位**（让位 = 从历史中间丢单元 = 改写已发送前缀）。
    // 放不下就把 needsArchive 标起来，由归档/上下文超长兜底处理。
    const summaryBlock = summary ? buildSummaryBlock(options, summary) : null;
    const buildGap = (firstSeq: number): { text: string; tokens: number; from: number; to: number } | null => {
        if (rendered.length === 0) return null;
        let from: number;
        if (summary) from = summaryBoundarySeq + 1;
        else from = index.epochStartSeq;
        const to = firstSeq - 1;
        if (to < from) return null;
        const text = earlierSummaryGapText(to - from + 1, from, to);
        return { text, tokens: estimateText(text) + 8, from, to };
    };
    const firstSeq = firstSelected();
    const gap = buildGap(firstSeq);
    // stale 摘要（区间与 edit/redact 相交）回退旧行为时，不把缺口当作「预算到顶」触发压缩：
    // 否则每轮都会触发一次压缩，而摘要文本无法被安全重算（X3 TODO），形成无效循环。
    // 注：`triggerOmitted` 字段已随"预算到顶"语义删除 —— 现在是 `needsArchive`（观测）+ 归档兜底。
    const reserved = (summaryBlock ? summaryBlock.tokens : 0) + (gap ? gap.tokens : 0);
    const needsArchive = used + reserved > available;

    // 冻结区划分（#163 REQ-D2-11/16）：已发送区 = 渲染序里 toSeq 不超过 anchor 的最长前缀。
    // `sliceAtAnchor` 用"此前 max(toSeq)"累积判据（工具组 toSeq 可能越过后续单元 seq）。
    //
    // anchor 来源优先级：`options.anchorSeq`（会话水位）> `prefixSnapshot.throughSeq`
    // （快照自带的上轮末尾，兜住只传快照不传 anchor 的调用方/测试）。
    const snapshot = options.prefixSnapshot;
    const anchorRaw = Number(options.anchorSeq);
    const anchor = Number.isFinite(anchorRaw) && anchorRaw > 0
        ? anchorRaw
        : (snapshot && Number.isFinite(snapshot.throughSeq) ? Number(snapshot.throughSeq) : 0);
    const frozenUnits = anchor > 0 ? rendered.slice(0, sliceAtAnchor(rendered, anchor).frozenCount) : [];
    // 冻结区前导消息数：摘要块 + 缺口提示各占 1 条（两者互相独立，缺口在无摘要时也会出现）。
    const frozenPrefixMessages = (summaryBlock ? 1 : 0) + (gap ? 1 : 0);

    const stats: CompileStats = {
        unitsTotal: units.length,
        unitsRendered: rendered.length,
        firstSelectedSeq: firstSeq,
        lastSelectedSeq: lastSelected(),
        estimatedTokens: used,
        needsArchive,
        summaryInjected: false,
        gapInjected: false,
        summaryBoundarySeq: summary ? summaryBoundarySeq : 0,
        summaryStale: stale,
        boundaryDefense,
        injectionBlocks: 0,
        injectionTokens,
    };

    let messages: CompiledMessage[] = prefix.slice();
    if (summaryBlock) {
        messages.push({ role: 'user', content: summaryBlock.text });
        stats.summaryInjected = true;
    }
    if (gap) {
        // 有摘要但摘要与窗口之间仍有未摘要区，或根本没有摘要：明确提示可回查（绝不静默）
        messages.push({ role: 'user', content: gap.text });
        stats.gapInjected = true;
    }

    const unitStarts: number[] = [];
    for (const unit of rendered) {
        unitStarts.push(messages.length);
        for (const message of renderUnit(unit, options, index)) messages.push(message);
    }

    // #163 REQ-D3-21~25：注入块按 `slot()` 归并到单元边界之外。
    // 主路径（`afterSeq = max(lastSentSeq, archivedThrough)`）插入点恒为数组末尾，
    // 即"上一轮的完整前缀 + 本轮新增注入块 + 本轮新消息"中的注入块位置。
    if (injectionSplit.injections.length > 0) {
        mergeInjectionMessages(messages, injectionSplit.injections, rendered, options.snapshot.head, unitStarts);
        stats.injectionBlocks = injectionSplit.injections.length;
    }
    stats.injectionTokens = injectionTokens;

    // #163 REQ-D2-16 冻结守卫：已发送前缀若在无 rebase 的情况下被改写，用快照覆盖回去。
    //
    // 这是**兜底**，不是正常路径（正常 `prefixDrift` 应恒为 undefined）。它的意义是：即使某处
    // 渲染逻辑漏了纯度（例如旧数据的 `[from]` 回落活名被改名），也只损失"这一次的漂移"，
    // 下轮起快照仍是同一份字节 —— 缓存不会一轮一轮地重新预热。同时把差异位置记进
    // `stats.prefixDrift`，由调用方记一次 `prefix-drift-freeze` rebase（不静默）。
    if (snapshot && snapshot.messages.length > 0) {
        const prev = snapshot.messages;
        const cur = messages.map(message => JSON.stringify(message));
        let diff = -1;
        const comparable = Math.min(prev.length, cur.length);
        for (let i = 0; i < comparable; i++) {
            if (cur[i] !== prev[i]) { diff = i; break; }
        }
        // 只有"上一轮更短"才算前缀被删短（本轮更短是归档的正常结果，不算漂移）
        if (diff < 0 && cur.length < prev.length) diff = cur.length;
        if (diff >= 0) {
            stats.prefixDrift = diff;
            // 冻结区消息数：prefix + summary/gap + 冻结单元渲染出的消息。
            // 守卫只在"漂移发生在冻结区"时才有意义 —— 漂移在增量区说明锚点没跟上，
            // 那属于调用方记账 bug，覆盖也会覆盖错，因此只在冻结区内生效。
            const frozenMessages = frozenPrefixMessages
                + frozenUnits.reduce((n, unit) => n + renderUnit(unit, options, index).length, 0);
            if (diff < frozenMessages && frozenMessages <= prev.length) {
                const head = prev.slice(0, frozenMessages).map(text => JSON.parse(text) as CompiledMessage);
                messages = [...head, ...messages.slice(frozenMessages)];
            }
        }
    }

    return { messages, stats };
}

/** 单个注入块的渲染文本：`[system:inject-<kind>] <正文> [/system]`（包装归框架，见执行方案 I-05） */
export function renderInjectionBlockText(ref: InjectionRef): string {
    const body = ref.meta.items.map(item => item.text).join('\n');
    return `[system:inject-${ref.meta.kind}] ${body} [/system]`;
}

/**
 * 把注入块按 `slot()` 插到渲染序里（**只在单元边界**，绝不劈开单元）。
 *
 * 排序：先 `slot` 位置，同位置按 `compareBlocks`（rank 升序、同类 seq 升序）⇒ 完全确定，
 * 同一快照两次编译字节一致（R2）。同位置的多个块合并成**一条**消息（顺序仍由 rank 决定）。
 */
function mergeInjectionMessages(
    messages: CompiledMessage[],
    injections: readonly InjectionRef[],
    selected: readonly ConversationUnit[],
    head: ContextSnapshot['head'],
    unitStarts: readonly number[],
): void {
    const placed = injections.map(ref => ({
        ref,
        pos: slot(
            { kind: ref.meta.kind, seq: Number(ref.event.seq) || 0, afterSeq: ref.meta.afterSeq },
            selected,
            head,
        ),
    }));
    placed.sort((a, b) => {
        if (a.pos !== b.pos) return a.pos - b.pos;
        return compareBlocks(
            { kind: a.ref.meta.kind, seq: Number(a.ref.event.seq) || 0 },
            { kind: b.ref.meta.kind, seq: Number(b.ref.event.seq) || 0 },
        );
    });
    const groups = new Map<number, InjectionRef[]>();
    for (const { ref, pos } of placed) {
        const bucket = groups.get(pos);
        if (bucket) bucket.push(ref);
        else groups.set(pos, [ref]);
    }
    const inserts: Array<{ at: number; content: string }> = [];
    for (const [pos, refs] of groups) {
        // pos === selected.length 时插到末尾（主路径）
        const at = pos < unitStarts.length ? unitStarts[pos] : messages.length;
        inserts.push({ at, content: refs.map(renderInjectionBlockText).join('\n') });
    }
    // 从后往前插，避免下标漂移
    inserts.sort((a, b) => b.at - a.at);
    for (const insert of inserts) {
        messages.splice(Math.max(0, Math.min(insert.at, messages.length)), 0, { role: 'user', content: insert.content });
    }
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
