// 上下文压缩的运行时编排：按目标保留量循环压批、单飞、节流、退避与每小时批次上限。
//
// v5 语义（与旧版不同）：
// - **触发不看水位**：调用方只在「编译发现未摘要原文被预算裁掉」（预算到顶）或手动 archive 时才调用；
// - `maybeRun(targetTokens)`：自动路径；`archiveNow(targetTokens)`：手动路径（忽略节流/每小时上限）；
// - 每次循环把「未摘要原文」压到 `targetTokens` 附近；每批按「还差多少到目标」截断，避免压过头；
// - `每小时上限` 计的是**批次数**（等价 aux LLM 调用数），不是运行次数。
//
// 约束：本文件不读 Config/seal；summarizer/estimator/时钟/记录 id 全部注入。
import { COMPACT_ARCHIVE_MAX_BATCHES, COMPACT_BATCH_TOKENS, COMPACT_MAX_BATCHES_PER_RUN } from "../../utils/context_limits";
import type { ConversationEvent } from "../events";

import { Backoff } from "./compactor";
import type { CompactResult } from "./compactor";

export interface CompactionRuntimeOptions {
    /** 单批送入摘要器的 token 上限 */
    batchTokens?: number;
    /** 摘要文本硬上限（字符） */
    summaryMaxChars?: number;
    /** 单次自动压缩最多连续压多少批 */
    maxBatchesPerRun?: number;
    /** 每小时最多压缩批次数；<=0 不限 */
    hourlyCap?: number;
    /** 自动压缩最小间隔（毫秒）；默认 60s */
    throttleMs?: number;
    /** 失败退避档位（毫秒） */
    backoffDelaysMs?: number[];
}

export interface CompactionRuntimeService {
    head(): { unsummarizedTokens: number };
    compact(options: { batchTokens: number; summaryMaxChars?: number }, deps: CompactionDeps): Promise<CompactResult>;
    flush(): Promise<{ ok: boolean; error?: string }>;
}

export interface CompactionDeps {
    summarize: (text: string) => Promise<string | null | undefined> | string | null | undefined;
    estimateEventTokens: (event: ConversationEvent) => number;
    now?: () => number;
    newRecordId?: (info: { epoch: number; fromSeq: number; toSeq: number; at: number }) => string;
}

export interface CompactionRuntimeDeps extends CompactionDeps {
    service: CompactionRuntimeService;
}

export interface CompactionRunResult {
    ran: boolean;
    advanced: boolean;
    /** 本次实际执行的批次数 */
    batches: number;
    /** 目标保留 token */
    targetTokens: number;
    /** 压缩前未摘要 token */
    pendingBefore: number;
    /** 压缩后未摘要 token */
    pendingAfter: number;
    /** 未完成原因（already-summarized / empty-summary / throttled / hourly-cap / running / ...） */
    reason?: string;
    error?: string;
}

const DEFAULT_THROTTLE_MS = 60_000;
const DEFAULT_HOURLY_CAP = 20;
const DEFAULT_MAX_BATCHES = COMPACT_MAX_BATCHES_PER_RUN;
const ARCHIVE_MAX_BATCHES = COMPACT_ARCHIVE_MAX_BATCHES;

export class CompactionRuntime {
    private readonly batchTokens: number;
    private readonly summaryMaxChars?: number;
    private readonly maxBatchesPerRun: number;
    private readonly hourlyCap: number;
    private readonly throttleMs: number;
    private readonly backoff: Backoff;
    private readonly now: () => number;
    private readonly deps: CompactionRuntimeDeps;

    private running = false;
    private lastAttemptAt = 0;
    private hourStart = 0;
    private callsThisHour = 0;
    private lastResult: CompactionRunResult | null = null;

    constructor(options: CompactionRuntimeOptions, deps: CompactionRuntimeDeps) {
        this.batchTokens = positiveInt(options.batchTokens, COMPACT_BATCH_TOKENS);
        this.summaryMaxChars = options.summaryMaxChars;
        this.maxBatchesPerRun = Math.max(1, positiveInt(options.maxBatchesPerRun, DEFAULT_MAX_BATCHES));
        this.hourlyCap = Math.max(0, Math.floor(options.hourlyCap ?? DEFAULT_HOURLY_CAP));
        this.throttleMs = Math.max(0, Math.floor(options.throttleMs ?? DEFAULT_THROTTLE_MS));
        this.backoff = new Backoff({ delaysMs: options.backoffDelaysMs });
        this.now = deps.now ?? (() => Date.now());
        this.deps = deps;
    }

    getLastResult(): CompactionRunResult | null {
        return this.lastResult;
    }

    /**
     * 自动压缩入口（仅在「预算到顶」触发的调用点使用）。
     * 失败/未完成会退避；退避不影响下一次显式 archive。
     */
    async maybeRun(targetTokens: number): Promise<CompactionRunResult> {
        const now = this.now();
        if (this.running) return this.skip('running', targetTokens);
        if (now < this.backoff.blockedUntil) return this.skip('backoff', targetTokens);
        if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < this.throttleMs) return this.skip('throttled', targetTokens);
        this.lastAttemptAt = now;
        return this.runToTarget(targetTokens, { manual: false, maxBatches: this.maxBatchesPerRun, now });
    }

    /** 手动 `.ai ctx archive`：忽略节流/每小时上限/退避，仍单飞。 */
    async archiveNow(targetTokens: number): Promise<CompactionRunResult> {
        const now = this.now();
        if (this.running) return this.skip('running', targetTokens);
        return this.runToTarget(targetTokens, { manual: true, maxBatches: ARCHIVE_MAX_BATCHES, now });
    }

    private async runToTarget(
        targetTokens: number,
        opts: { manual: boolean; maxBatches: number; now: number },
    ): Promise<CompactionRunResult> {
        this.running = true;
        const pendingBefore = pendingOf(this.deps.service);
        const result: CompactionRunResult = {
            ran: true,
            advanced: false,
            batches: 0,
            targetTokens: Math.max(1, Math.floor(targetTokens)),
            pendingBefore,
            pendingAfter: pendingBefore,
        };
        try {
            if (!opts.manual) this.rollHour(opts.now);
            let lastError: string | undefined;
            while (result.batches < opts.maxBatches) {
                const pending = pendingOf(this.deps.service);
                if (pending <= result.targetTokens) break;
                // 只按「还差多少到目标」截断本批，避免一次压到目标以下过多
                const batchTokens = Math.max(1, Math.min(this.batchTokens, pending - result.targetTokens));
                if (!opts.manual) {
                    if (this.hourlyCap > 0 && this.callsThisHour >= this.hourlyCap) {
                        result.reason = 'hourly-cap';
                        break;
                    }
                    this.callsThisHour++;
                }
                const batch = await this.deps.service.compact(
                    { batchTokens, summaryMaxChars: this.summaryMaxChars },
                    {
                        summarize: this.deps.summarize,
                        estimateEventTokens: this.deps.estimateEventTokens,
                        now: () => this.now(),
                        newRecordId: this.deps.newRecordId,
                    },
                );
                if (!batch.advanced) {
                    result.reason = batch.reason ?? 'not-advanced';
                    lastError = batch.error;
                    break;
                }
                result.advanced = true;
                result.batches++;
            }
            if (result.advanced) {
                const flushed = await this.deps.service.flush();
                if (!flushed.ok) {
                    result.reason = `flush-failed: ${flushed.error ?? 'unknown'}`;
                    this.backoff.fail(this.now());
                } else {
                    this.backoff.reset();
                }
            } else if (result.reason === 'summary-error' || result.reason === 'missing-history') {
                this.backoff.fail(this.now());
            } else if (result.batches > 0 && result.reason === 'flush-failed') {
                this.backoff.fail(this.now());
            }
            result.pendingAfter = pendingOf(this.deps.service);
            if (lastError) result.error = lastError;
            if (!result.advanced && !result.reason) result.reason = 'nothing-to-do';
            this.lastResult = result;
            return result;
        } catch (error) {
            this.backoff.fail(this.now());
            const out: CompactionRunResult = {
                ...result,
                advanced: false,
                reason: error instanceof Error ? error.message : String(error),
                pendingAfter: pendingOf(this.deps.service),
            };
            this.lastResult = out;
            return out;
        } finally {
            this.running = false;
        }
    }

    private skip(reason: string, targetTokens: number): CompactionRunResult {
        const result: CompactionRunResult = {
            ran: false,
            advanced: false,
            batches: 0,
            targetTokens: Math.max(1, Math.floor(targetTokens)),
            pendingBefore: 0,
            pendingAfter: 0,
            reason,
        };
        try {
            const pending = pendingOf(this.deps.service);
            result.pendingBefore = pending;
            result.pendingAfter = pending;
        } catch { /* ignore */ }
        this.lastResult = result;
        return result;
    }

    private rollHour(now: number): void {
        const bucket = Math.floor(now / 3_600_000);
        if (bucket !== this.hourStart) {
            this.hourStart = bucket;
            this.callsThisHour = 0;
        }
    }
}

function pendingOf(service: CompactionRuntimeService): number {
    try {
        const pending = Number(service.head()?.unsummarizedTokens);
        return Number.isFinite(pending) ? Math.max(0, Math.floor(pending)) : 0;
    } catch {
        return 0;
    }
}

function positiveInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    const v = Math.floor(n);
    return v > 0 ? v : fallback;
}
