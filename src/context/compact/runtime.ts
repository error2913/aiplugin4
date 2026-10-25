// 后台滚动摘要的运行时编排：水位/节流/小时上限/退避/单飞。
// 只做"什么时候该压、压完 flush"，不关心摘要质量与渲染（compactor/service 负责）。
import type { ConversationEvent, RecordEntry } from "../events";

import { Backoff } from "./compactor";
import type { CompactResult } from "./compactor";

export interface CompactionRuntimeOptions {
    /** 积压 token 水位；<=0 关闭自动压缩 */
    watermarkTokens: number;
    /** 单次压缩最多吃进多少 token 的段 */
    batchTokens: number;
    /** 摘要文本硬上限（字符） */
    summaryMaxChars?: number;
    /** 每小时最多自动压缩次数；<=0 不限制 */
    hourlyCap?: number;
    /** 自动压缩最小间隔（毫秒）；默认 60s */
    throttleMs?: number;
    /** 失败退避档位（毫秒） */
    backoffDelaysMs?: number[];
}

export type CompactionTrigger = 'run-end' | 'idle' | 'manual';

export interface CompactionRuntimeService {
    shouldCompact(watermarkTokens: number): boolean;
    compact(
        options: { batchTokens: number; summaryMaxChars?: number },
        deps: {
            summarize: (text: string) => Promise<string | null | undefined> | string | null | undefined;
            estimateEventTokens: (event: ConversationEvent) => number;
            now?: () => number;
            newRecordId?: (info: { epoch: number; fromSeq: number; toSeq: number; at: number }) => string;
        },
    ): Promise<CompactResult>;
    flush(): Promise<{ ok: boolean; error?: string }>;
}

export interface CompactionRuntimeDeps {
    service: CompactionRuntimeService;
    summarize: (text: string) => Promise<string | null | undefined> | string | null | undefined;
    /** 事件 token 估算；与 compile/存储保持同一口径 */
    estimateEventTokens: (event: ConversationEvent) => number;
    /** 时钟（测试注入）；缺省 Date.now */
    now?: () => number;
    /** 摘要记录 id 生成（同 toSeq 重算时可带版本） */
    newRecordId?: (info: { epoch: number; fromSeq: number; toSeq: number; at: number }) => string;
}

export type CompactionSkipReason =
    | 'disabled'
    | 'backlog-below-watermark'
    | 'throttled'
    | 'hourly-cap'
    | 'backoff'
    | 'running';

export interface CompactionRunResult {
    ran: boolean;
    advanced: boolean;
    reason?: CompactionSkipReason | string;
    record?: RecordEntry;
    through?: number;
    flushed?: boolean;
}

const DEFAULT_THROTTLE_MS = 60_000;
const DEFAULT_HOURLY_CAP = 6;

export class CompactionRuntime {
    private readonly watermarkTokens: number;
    private readonly batchTokens: number;
    private readonly summaryMaxChars?: number;
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
        this.watermarkTokens = Math.max(0, Math.floor(options.watermarkTokens));
        this.batchTokens = Math.max(1, Math.floor(options.batchTokens));
        this.summaryMaxChars = options.summaryMaxChars;
        this.hourlyCap = Math.max(0, Math.floor(options.hourlyCap ?? DEFAULT_HOURLY_CAP));
        this.throttleMs = Math.max(0, Math.floor(options.throttleMs ?? DEFAULT_THROTTLE_MS));
        this.backoff = new Backoff({ delaysMs: options.backoffDelaysMs });
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }

    /** 最近一次运行结果（`.ai ctx status` 用） */
    getLastResult(): CompactionRunResult | null {
        return this.lastResult;
    }

    /**
     * 自动压缩入口（run 结束/空闲检查调用）。
     * 返回 skipped 原因，调用方可据此决定是否在下一轮重试。
     */
    async maybeRun(): Promise<CompactionRunResult> {
        const now = this.now();
        if (this.watermarkTokens <= 0) return this.skip('disabled');
        if (this.running) return this.skip('running');
        if (now < this.backoff.blockedUntil) return this.skip('backoff');
        if (!this.deps.service.shouldCompact(this.watermarkTokens)) return this.skip('backlog-below-watermark');
        this.rollHour(now);
        if (this.hourlyCap > 0 && this.callsThisHour >= this.hourlyCap) return this.skip('hourly-cap');
        if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < this.throttleMs) return this.skip('throttled');
        return this.run(now, false);
    }

    /** 手动 `.ai ctx archive`：忽略水位/节流/小时上限，仍单飞；失败退避 */
    async archiveNow(): Promise<CompactionRunResult> {
        if (this.running) return this.skip('running');
        return this.run(this.now(), true);
    }

    private async run(now: number, manual: boolean): Promise<CompactionRunResult> {
        this.running = true;
        this.lastAttemptAt = now;
        this.rollHour(now);
        if (!manual) this.callsThisHour++;
        try {
            const result = await this.deps.service.compact(
                { batchTokens: this.batchTokens, summaryMaxChars: this.summaryMaxChars },
                {
                    summarize: this.deps.summarize,
                    estimateEventTokens: this.deps.estimateEventTokens,
                    now: () => this.now(),
                    newRecordId: this.deps.newRecordId,
                },
            );
            const out: CompactionRunResult = {
                ran: true,
                advanced: result.advanced,
                reason: result.reason,
                record: result.record ?? undefined,
                through: result.through,
            };
            if (result.advanced) {
                const flushed = await this.deps.service.flush();
                out.flushed = flushed.ok;
                if (!flushed.ok) {
                    out.reason = `flush-failed: ${flushed.error ?? 'unknown'}`;
                    this.backoff.fail(this.now());
                } else {
                    this.backoff.reset();
                }
            } else if (result.reason === 'summary-error' || result.reason === 'missing-history') {
                this.backoff.fail(this.now());
            }
            this.lastResult = out;
            return out;
        } catch (error) {
            this.backoff.fail(this.now());
            const out: CompactionRunResult = {
                ran: true,
                advanced: false,
                reason: error instanceof Error ? error.message : String(error),
            };
            this.lastResult = out;
            return out;
        } finally {
            this.running = false;
        }
    }

    private skip(reason: CompactionSkipReason): CompactionRunResult {
        const result: CompactionRunResult = { ran: false, advanced: false, reason };
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
