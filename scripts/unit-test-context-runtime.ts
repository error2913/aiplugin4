// 压缩运行时编排单测：目标循环/clamp/批次数上限/退避/单飞/手动归档/flush 失败。
// v5 语义：自动路径=单飞+失败退避+单次最多 20 批（无节流/每小时上限）；手动 archive 最多 200 批。
import assert from 'node:assert/strict';

import { CompactionRuntime } from '../src/context/compact/runtime';
import type { CompactResult } from '../src/context/compact/compactor';
import { retainedTargetTokens } from '../src/utils/context_limits';

interface FakeOptions {
    advanced?: boolean;
    reason?: string;
    flushOk?: boolean;
    defer?: boolean;
    /** 每次成功压缩减少的 pending token 数 */
    drop?: number;
}

function makeFake(opts: FakeOptions = {}) {
    const state = {
        pending: 10_000,
        calls: 0,
        flushes: 0,
        summaries: [] as string[],
        resolve: null as null | (() => void),
    };
    const service = {
        head: () => ({ unsummarizedTokens: state.pending }),
        compact: async (_o: unknown, deps: { summarize: (text: string) => string }) => {
            state.calls++;
            state.summaries.push(deps.summarize('input'));
            if (opts.defer && state.calls === 1) {
                await new Promise<void>(resolve => { state.resolve = resolve; });
            }
            const advanced = opts.advanced ?? true;
            const next = advanced ? Math.max(0, state.pending - (opts.drop ?? 100)) : state.pending;
            const result: CompactResult = {
                advanced,
                reason: opts.reason,
                record: advanced
                    ? {
                        kind: 'summary',
                        id: `sum:${state.calls}`,
                        at: 1,
                        epoch: 1,
                        fromSeq: 1,
                        toSeq: 2,
                        text: '摘要',
                    }
                    : null,
                through: advanced ? 2 : 0,
                unsummarizedTokens: next,
                batch: null,
                inputChars: 0,
                truncated: false,
            };
            if (advanced) state.pending = next;
            return result;
        },
        flush: async () => {
            state.flushes++;
            return { ok: opts.flushOk ?? true, error: opts.flushOk === false ? 'boom' : undefined };
        },
    };
    return { service, state };
}

function runtimeOf(service: any, now: () => number, extra: Partial<{ maxBatchesPerRun: number; backoffDelaysMs: number[] }> = {}) {
    return new CompactionRuntime({
        batchTokens: 100,
        maxBatchesPerRun: extra.maxBatchesPerRun ?? 20,
        ...(extra.backoffDelaysMs ? { backoffDelaysMs: extra.backoffDelaysMs } : {}),
    }, {
        service,
        summarize: () => '摘要',
        estimateEventTokens: () => 10,
        now,
    });
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextLimitsTargetMath() {
        assert.equal(retainedTargetTokens(131072, 30), 39321);
        assert.equal(retainedTargetTokens(0, 30), 0);
    },

    async testCompactionRuntimeCompactsToTargetAndFlushes() {
        const now = 10_000;
        const { service, state } = makeFake({ drop: 100 });
        state.pending = 200;
        const runtime = runtimeOf(service, () => now);
        const result = await runtime.maybeRun(100);
        assert.equal(result.ran, true);
        assert.equal(result.advanced, true);
        assert.equal(state.calls, 1);
        assert.equal(state.flushes, 1);
        assert.equal(result.pendingAfter, 100);

        // 已压到目标：再次触发是 no-op（不再调用摘要器），没有节流这回事
        const again = await runtime.maybeRun(100);
        assert.equal(again.advanced, false);
        assert.equal(again.reason, 'nothing-to-do');
        assert.equal(again.pendingAfter, 100);
        assert.equal(state.calls, 1, '到目标后不得再压批');
        assert.equal(state.flushes, 1);
    },

    async testCompactionRuntimeNothingToDo() {
        const { service } = makeFake();
        service.head = () => ({ unsummarizedTokens: 100 });
        const runtime = runtimeOf(service, () => 10_000);
        const result = await runtime.maybeRun(4000);
        assert.equal(result.advanced, false);
        assert.equal(result.reason, 'nothing-to-do');
    },

    async testCompactionRuntimeAutoPathDefaultBatchCap() {
        // 自动路径单次最多 20 批（COMPACT_MAX_BATCHES_PER_RUN），且不再有「每小时上限」拦截：
        // 同一小时内可以连续触发（只受目标/退避/单飞约束），但单次仍不会压超过 20 批。
        const now = 10_000;
        const { service, state } = makeFake({ drop: 100 });
        state.pending = 10_000;
        const runtime = runtimeOf(service, () => now);
        const first = await runtime.maybeRun(1_000);
        assert.equal(first.advanced, true);
        assert.equal(first.batches, 20, '自动路径默认单次最多 20 批');
        assert.equal(state.calls, 20);
        assert.equal(first.reason, undefined, '不存在 hourly-cap 截断原因');
        assert.equal(first.pendingAfter, 8_000);
        // 同一小时内再触发：不再被“每小时上限”拦截，继续压（说明额度/次数由调用方门闩控制）
        const second = await runtime.maybeRun(1_000);
        assert.equal(second.ran, true);
        assert.equal(second.advanced, true);
        assert.equal(second.batches, 20);
        assert.equal(second.reason, undefined);
    },

    async testCompactionRuntimeNoOvershootNearTarget() {
        const { service, state } = makeFake({ drop: 100 });
        state.pending = 5000;
        const runtime = runtimeOf(service, () => 10_000, { maxBatchesPerRun: 20 });
        const result = await runtime.maybeRun(4900);
        assert.equal(result.advanced, true);
        assert.equal(result.batches, 1);
        assert.equal(result.pendingAfter, 4900, '只压到目标附近，不应整批压过头');
    },

    async testCompactionRuntimeMaxBatchesPerRun() {
        const { service, state } = makeFake({ drop: 100 });
        state.pending = 10_000;
        const runtime = runtimeOf(service, () => 10_000, { maxBatchesPerRun: 3 });
        const result = await runtime.maybeRun(100);
        assert.equal(result.batches, 3);
        assert.equal(state.calls, 3);
    },

    async testCompactionRuntimeFailureBackoff() {
        let now = 10_000;
        const { service } = makeFake({ advanced: false, reason: 'summary-error' });
        const runtime = runtimeOf(service, () => now);
        const first = await runtime.maybeRun(1000);
        assert.equal(first.advanced, false);
        assert.equal(first.reason, 'summary-error');
        now += 1000;
        const blocked = await runtime.maybeRun(1000);
        assert.equal(blocked.ran, false);
        assert.equal(blocked.reason, 'backoff');
        now += 60 * 60 * 1000;
        const after = await runtime.maybeRun(1000);
        assert.equal(after.advanced, false, '摘要仍失败，不推进');
    },

    async testCompactionRuntimeFlushFailure() {
        const { service, state } = makeFake({ flushOk: false });
        state.pending = 200;
        const runtime = runtimeOf(service, () => 10_000);
        const result = await runtime.maybeRun(100);
        assert.equal(result.advanced, true);
        assert.ok(String(result.reason).includes('flush-failed'));
    },

    async testCompactionRuntimeSingleFlightAndManualArchive() {
        let now = 10_000;
        const { service, state } = makeFake({ defer: true, drop: 100 });
        state.pending = 10_000;
        const runtime = runtimeOf(service, () => now);
        const first = runtime.maybeRun(100);
        const second = await runtime.maybeRun(100);
        assert.equal(second.ran, false);
        assert.equal(second.reason, 'running');
        state.resolve!();
        assert.equal((await first).advanced, true);
        now += 1;
        // 手动归档忽略节流/小时上限
        const manual = await runtime.archiveNow(100);
        assert.equal(manual.ran, true);
        assert.equal(manual.advanced, true);
    },
};
