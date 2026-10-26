// Context v2 滚动摘要器（纯逻辑）：把"最早的未摘要段"压成一条 rolling SummaryRecord。
//
// 设计约束（.dev/context-v2-design.md §6/§7 + gap-review X1/X3/X4）：
// - 只压缩**当前 epoch 且模型可见**的事件：先 `applyVisibility`，再 `segmentUnits`；
//   切点只落在**单元边界**，工具组整组进/整组出（不拆 assistant(tool_calls) 与 tool 结果）。
// - 每 epoch 只保留一条 rolling summary（X4）：`fromSeq = epochStartSeq`，`toSeq` 单调推进；
//   输入 = 上一条 rolling summary.text + 本段渲染文本，输出整段新摘要（滚动重写，不做链）。
// - 幂等（INV-I/J）：`head.summarizedThrough` 决定起点；若已有 summary.toSeq >= 本次候选 toSeq，
//   直接不推进（不调用 summarize、不产生记录）。重复调用同一输入的第二次结果一致。
// - 失败/空摘要 → 不推进、不产生记录，返回 reason 供调用方退避（Backoff）。
// - 纯函数 + 注入依赖：不 import seal/storage/Config/utils；summarizer/estimator/时钟/记录 id 全部注入。
// - 本文件**不写 store**：成功时返回 record/through/remaining，调用方用
//   `store.commitSummary(record, through, remaining)` 落库。
import {
    EXISTING_SUMMARY_HEADER,
    NEW_CONTENT_HEADER,
    SUMMARY_TRUNCATE_MARK,
    SYSTEM_NAME,
} from "../../utils/protocol";
import { toLLMText } from "../content/llm";
import type { ConversationEvent, RecordEntry, SummaryRecord } from "../events";
import type { ContextHead } from "../head";
import { applyEdit, applyVisibility, buildRecordIndex, latestSummary, RecordIndex } from "../view/records";
import { ConversationUnit, estimateUnitTokens, segmentUnits } from "../view/units";

/** 摘要文本默认硬上限（字符）：超出截断并标记，避免摘要本身撑爆请求预算 */
export const DEFAULT_SUMMARY_MAX_CHARS = 2000;
/** 摘要截断标记（截断后的正文以它结尾，且最终长度不超过上限）；**会持久化**进 SummaryRecord */
export { SUMMARY_TRUNCATE_MARK };

export interface CompactInput {
    /** 当前已加载的可见性判断依据（事件可以只是最近窗口） */
    events: readonly ConversationEvent[];
    /** 全部记录（summary/edit/supersede/redact/epoch） */
    records: readonly RecordEntry[];
    head: Readonly<ContextHead>;
}

export interface CompactOptions {
    /** 单次送入摘要器的未摘要段 token 上限；必须为正数 */
    batchTokens: number;
    /** 摘要文本硬上限（字符）；<=0 表示不截断。默认 DEFAULT_SUMMARY_MAX_CHARS */
    summaryMaxChars?: number;
}

/**
 * 注入依赖：
 * - summarize：摘要器（纯逻辑测试用 fake；生产接 aux llm）。返回 null/空串视为失败。
 * - estimateEventTokens：与 compile/request 同一口径的单事件 token 估算。
 * - now/newRecordId：可选，便于测试确定性。
 */
export interface CompactDeps {
    summarize: (text: string) => Promise<string | null | undefined> | string | null | undefined;
    estimateEventTokens: (event: ConversationEvent) => number;
    now?: () => number;
    newRecordId?: (info: { epoch: number; fromSeq: number; toSeq: number; at: number }) => string;
}

export type CompactSkipReason =
    | 'invalid-batch'
    | 'invalid-head'
    | 'no-unsummarized-events'
    | 'missing-history'
    | 'already-summarized'
    | 'empty-segment'
    | 'empty-summary'
    | 'summary-error';

/** 本次候选段信息（调试/日志/测试用） */
export interface CompactBatchInfo {
    /** 段内最早单元起始 seq（可能 > epochStartSeq：更早的已被上一条摘要覆盖） */
    fromSeq: number;
    /** 段末单元结束 seq（= 摘要 record.toSeq） */
    toSeq: number;
    /** 段内可见单元数 */
    unitCount: number;
    /** 段 token 估算合计 */
    tokens: number;
}

export interface CompactResult {
    /** 是否产生了新的 summary（调用方据此决定是否 commitSummary） */
    advanced: boolean;
    /** 未推进原因 */
    reason?: CompactSkipReason;
    /** 成功时的滚动摘要记录（未推进为 null） */
    record: SummaryRecord | null;
    /** 提交后应写入 head.summarizedThrough 的值；未推进时为原值 */
    through: number;
    /** 提交后应写入 head.unsummarizedTokens 的值（仅统计仍未摘要的可见事件） */
    unsummarizedTokens: number;
    /** 本次候选段（未推进且未选出段时为 null） */
    batch: CompactBatchInfo | null;
    /** 送入摘要器的输入字符数 */
    inputChars: number;
    /** 摘要文本是否被 summaryMaxChars 截断 */
    truncated: boolean;
    /** reason='summary-error' 时的错误信息 */
    error?: string;
}

function finiteInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
    const n = finiteInt(value, fallback);
    return n > 0 ? n : fallback;
}

function renderEventText(event: ConversationEvent, index: RecordIndex): string {
    const text = toLLMText(applyEdit(event, index), { vision: false });
    switch (event.kind) {
        case 'user':
            return `[user ${event.uid || '?'} @${event.at}] ${text}`;
        case 'assistant':
            return `[AI @${event.at}] ${text}`;
        case 'event':
            return `[event ${event.systemName || SYSTEM_NAME.event}] ${text}`;
        case 'tool_call':
            return `[tool call ${event.name || event.callId}] ${event.args || ''}`;
        case 'tool_result':
            return `[tool result ${event.name || event.callId}] ${text}`;
        default:
            return text;
    }
}

/** 单元 → 摘要输入文本（不依赖 renderer 的消息格式；带说话者/时间/工具名，供摘要器理解） */
function renderUnitText(unit: ConversationUnit, index: RecordIndex): string {
    const lines: string[] = [];
    for (const event of unit.events) lines.push(renderEventText(event, index));
    if (unit.kind === 'tool_group' && !unit.complete && unit.missingCallIds && unit.missingCallIds.length > 0) {
        lines.push(`[unfinished tool calls: ${unit.missingCallIds.join(', ')}]`);
    }
    return lines.join('\n');
}

/** 一组单元 → 段文本（单元之间空行分隔） */
function renderUnitsText(units: readonly ConversationUnit[], index: RecordIndex): string {
    return units.map(unit => renderUnitText(unit, index)).join('\n\n');
}

function applySummaryLimit(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
        return { text, truncated: false };
    }
    const room = Math.max(0, maxChars - SUMMARY_TRUNCATE_MARK.length);
    if (room <= 0) return { text: text.slice(0, Math.max(0, maxChars)), truncated: true };
    return { text: text.slice(0, room) + SUMMARY_TRUNCATE_MARK, truncated: true };
}

function makeRecord(deps: CompactDeps, epoch: number, fromSeq: number, toSeq: number, text: string): SummaryRecord {
    const at = finiteInt(deps.now ? deps.now() : Date.now(), Date.now());
    const id = deps.newRecordId
        ? deps.newRecordId({ epoch, fromSeq, toSeq, at })
        : `sum:${epoch}:${toSeq}:${at}`;
    return { id, at, kind: 'summary', epoch, fromSeq, toSeq, text };
}

function computeRemainingTokens(
    units: readonly ConversationUnit[],
    fromIndex: number,
    estimateEventTokens: (event: ConversationEvent) => number,
): number {
    let total = 0;
    for (let i = fromIndex; i < units.length; i++) {
        total += Math.max(0, estimateUnitTokens(units[i], estimateEventTokens));
    }
    return total;
}

/**
 * 压缩一次：取 `head.summarizedThrough+1` 起最早的连续可见单元段（受 batchTokens 约束），
 * 调注入的 summarizer 生成滚动摘要；不写 store，成功返回待提交的 record/through/remaining。
 *
 * 关键边界：
 * - 第一个单元就超过 batchTokens 时允许"单单元"（绝不拆工具组）；
 * - 切点只在单元之间（`segmentUnits` 的单元边界）；
 * - 不完整工具组/孤儿结果照常计入段文本（compile 层负责展示降级）。
 */
export async function compactOnce(
    input: CompactInput,
    opts: CompactOptions,
    deps: CompactDeps,
): Promise<CompactResult> {
    const head = input.head;
    const batchTokens = finiteInt(opts.batchTokens, 0);
    const through = Math.max(0, finiteInt(head && head.summarizedThrough, 0));
    const base = (): CompactResult => ({
        advanced: false,
        record: null,
        through,
        unsummarizedTokens: Math.max(0, finiteInt(head && head.unsummarizedTokens, 0)),
        batch: null,
        inputChars: 0,
        truncated: false,
    });
    if (batchTokens <= 0) return { ...base(), reason: 'invalid-batch' };
    if (!head || !Number.isFinite(head.epochStartSeq)) return { ...base(), reason: 'invalid-head' };

    const index = buildRecordIndex(input.records);
    const headEpoch = finiteInt(head.epoch, index.epoch);
    const epochStartSeq = Math.max(1, finiteInt(head.epochStartSeq, index.epochStartSeq));
    const startSeq = Math.max(epochStartSeq, through + 1);

    // 历史窗口校验：若输入里最早的事件都比 startSeq 晚，说明"未摘要区间"的事件没加载进来
    // （store 只加载最近若干页 / 页被清理）。此时绝不能生成 fromSeq=epochStartSeq 的摘要——
    // 那等于谎报覆盖，会造出 INV-C 静默缺口。
    let minLoadedSeq = Number.POSITIVE_INFINITY;
    for (const event of input.events) {
        const seq = finiteInt(event && (event as { seq?: unknown }).seq, Number.NaN);
        if (Number.isFinite(seq) && seq > 0 && seq < minLoadedSeq) minLoadedSeq = seq;
    }
    if (Number.isFinite(minLoadedSeq) && minLoadedSeq > startSeq) {
        return { ...base(), reason: 'missing-history' };
    }

    // 可见事件 → 单元（切点只在单元边界；工具组整组）
    const visible = applyVisibility(input.events, index);
    const units = segmentUnits(visible);
    const candidates = units.filter(unit => unit.toSeq >= startSeq);
    const batchUnits: ConversationUnit[] = [];
    let batchTokensUsed = 0;
    let lastCandidateIndex = -1;
    for (let i = 0; i < candidates.length; i++) {
        const unit = candidates[i];
        const tokens = Math.max(0, estimateUnitTokens(unit, deps.estimateEventTokens));
        if (batchUnits.length === 0) {
            batchUnits.push(unit);
            batchTokensUsed = tokens;
            lastCandidateIndex = i;
            continue;
        }
        if (batchTokensUsed + tokens > batchTokens) break;
        batchUnits.push(unit);
        batchTokensUsed += tokens;
        lastCandidateIndex = i;
    }
    if (batchUnits.length === 0) {
        return { ...base(), reason: headEpoch > index.epoch ? 'invalid-head' : 'no-unsummarized-events' };
    }

    const segmentFromSeq = batchUnits[0].fromSeq;
    const toSeq = batchUnits[batchUnits.length - 1].toSeq;
    const batch: CompactBatchInfo = {
        fromSeq: segmentFromSeq,
        toSeq,
        unitCount: batchUnits.length,
        tokens: batchTokensUsed,
    };
    const remainingTokens = computeRemainingTokens(units, units.indexOf(candidates[lastCandidateIndex]) + 1, deps.estimateEventTokens);

    // 上一条 rolling summary：
    // - 输入用 `startSeq-1`（覆盖段之前的全部内容）；
    // - 幂等守卫用 `toSeq`（若已有摘要已经覆盖到本次候选末尾，绝不重复压缩/覆盖）。
    // head 与记录必须同 epoch（epoch 重置记录尚未落盘时忽略旧摘要，绝不回退）。
    const sameEpoch = headEpoch === index.epoch;
    const previous = sameEpoch ? latestSummary(index, Math.max(0, startSeq - 1)) : null;
    const covering = sameEpoch ? latestSummary(index, toSeq) : null;
    if (covering && finiteInt(covering.toSeq, 0) >= toSeq) {
        return {
            ...base(),
            reason: 'already-summarized',
            batch,
            unsummarizedTokens: remainingTokens,
        };
    }
    const previousText = previous && typeof previous.text === 'string' ? previous.text.trim() : '';

    const segmentText = renderUnitsText(batchUnits, index);
    const summarizeInput = previousText
        ? `${EXISTING_SUMMARY_HEADER}\n${previousText}\n\n${NEW_CONTENT_HEADER}\n${segmentText}`
        : segmentText;
    if (summarizeInput.trim() === '') {
        return { ...base(), reason: 'empty-segment', batch };
    }

    let summarized: string | null | undefined;
    try {
        summarized = await deps.summarize(summarizeInput);
    } catch (error) {
        return {
            ...base(),
            reason: 'summary-error',
            batch,
            inputChars: summarizeInput.length,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const trimmed = typeof summarized === 'string' ? summarized.trim() : '';
    if (trimmed === '') {
        return { ...base(), reason: 'empty-summary', batch, inputChars: summarizeInput.length };
    }

    const maxChars = opts.summaryMaxChars === undefined
        ? DEFAULT_SUMMARY_MAX_CHARS
        : finiteInt(opts.summaryMaxChars, DEFAULT_SUMMARY_MAX_CHARS);
    const limited = applySummaryLimit(trimmed, maxChars);
    const epoch = headEpoch > index.epoch ? headEpoch : index.epoch;
    const record = makeRecord(deps, epoch, epochStartSeq, toSeq, limited.text);
    return {
        advanced: true,
        record,
        through: toSeq,
        unsummarizedTokens: remainingTokens,
        batch,
        inputChars: summarizeInput.length,
        truncated: limited.truncated,
    };
}

/**
 * 是否满足后台压缩的**积压条件**（纯逻辑；不含"不在 run 中/节流/小时上限"，那些由调用方判断）：
 * - watermarkTokens <= 0 → 关闭（配置语义：0=关）；
 * - 必须还有未摘要事件（summarizedThrough < nextSeq-1 且当前 epoch 内有事件）；
 * - 未摘要 token 积压 ≥ 水位。
 */
export function shouldCompact(head: Readonly<ContextHead>, watermarkTokens: number): boolean {
    if (!head) return false;
    const watermark = finiteInt(watermarkTokens, 0);
    if (watermark <= 0) return false;
    const nextSeq = finiteInt(head.nextSeq, 1);
    const lastSeq = Math.max(0, nextSeq - 1);
    const epochStartSeq = Math.max(1, finiteInt(head.epochStartSeq, 1));
    const through = Math.max(0, finiteInt(head.summarizedThrough, 0));
    if (lastSeq < epochStartSeq) return false;      // 当前 epoch 还没有事件
    if (through >= lastSeq) return false;           // 没有未摘要事件
    const pending = Math.max(0, finiteInt(head.unsummarizedTokens, 0));
    return pending >= watermark;
}

/** 指数退避（纯逻辑）：默认 5 / 15 / 60 分钟，之后封顶 60 分钟（设计 gap-review X9） */
export interface BackoffOptions {
    /** 各次失败对应的退避时长（ms）；缺省 [5min, 15min, 60min] */
    delaysMs?: readonly number[];
}

const DEFAULT_BACKOFF_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export class Backoff {
    private readonly delays: readonly number[];
    private failures = 0;
    private blockedUntilMs = 0;

    constructor(options: BackoffOptions = {}) {
        const input = Array.isArray(options.delaysMs) && options.delaysMs.length > 0
            ? options.delaysMs
            : DEFAULT_BACKOFF_DELAYS_MS;
        const sanitized: number[] = [];
        for (const value of input) {
            const n = positiveInt(value, 0);
            if (n > 0) sanitized.push(n);
        }
        this.delays = sanitized.length > 0 ? sanitized : DEFAULT_BACKOFF_DELAYS_MS;
    }

    get failureCount(): number {
        return this.failures;
    }

    get blockedUntil(): number {
        return this.blockedUntilMs;
    }

    /** 第 n 次失败（n>=1）对应的退避毫秒数（不改变状态）；超出列表长度按最后一项封顶 */
    delayMsFor(failure: number): number {
        const n = Math.max(1, Math.floor(failure));
        const index = Math.min(n - 1, this.delays.length - 1);
        return this.delays[index];
    }

    /** 记录一次失败并进入退避；返回本次退避时长（ms） */
    fail(now: number = Date.now()): number {
        this.failures += 1;
        const delay = this.delayMsFor(this.failures);
        this.blockedUntilMs = now + delay;
        return delay;
    }

    /** 成功（或手动解除）后清零 */
    reset(): void {
        this.failures = 0;
        this.blockedUntilMs = 0;
    }

    isBlocked(now: number = Date.now()): boolean {
        return now < this.blockedUntilMs;
    }

    remainingMs(now: number = Date.now()): number {
        return Math.max(0, this.blockedUntilMs - now);
    }
}
