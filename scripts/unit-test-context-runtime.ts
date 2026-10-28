// 压缩运行时编排单测：目标循环/clamp/批次数上限/节流/退避/单飞/手动归档/flush 失败。
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

function runtimeOf(service: any, now: () => number, extra: Partial<{ hourlyCap: number; throttleMs: number; maxBatchesPerRun: number }> = {}) {
    return new CompactionRuntime({
        batchTokens: 100,
        maxBatchesPerRun: extra.maxBatchesPerRun ?? 20,
        hourlyCap: extra.hourlyCap ?? 10,
        throttleMs: extra.throttleMs ?? 1000,
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
        let now = 10_000;
        const { service, state } = makeFake({ drop: 100 });
        state.pending = 200;
        const runtime = runtimeOf(service, () => now);
        const result = await runtime.maybeRun(100);
        assert.equal(result.ran, true);
        assert.equal(result.advanced, true);
        assert.equal(state.calls, 1);
        assert.equal(state.flushes, 1);
        assert.equal(result.pendingAfter, 100);

        now += 500;
        const throttled = await runtime.maybeRun(100);
        assert.equal(throttled.ran, false);
        assert.equal(throttled.reason, 'throttled');
    },

    async testCompactionRuntimeNothingToDo() {
        const { service } = makeFake();
        service.head = () => ({ unsummarizedTokens: 100 });
        const runtime = runtimeOf(service, () => 10_000);
        const result = await runtime.maybeRun(4000);
        assert.equal(result.advanced, false);
        assert.equal(result.reason, 'nothing-to-do');
    },

    async testCompactionRuntimeHourlyCapCountsBatches() {
        let now = 10_000;
        const { service, state } = makeFake({ drop: 100 });
        state.pending = 10_000;
        const runtime = runtimeOf(service, () => now, { throttleMs: 0, hourlyCap: 2 });
        const first = await runtime.maybeRun(1000);
        assert.equal(first.advanced, true);
        assert.equal(state.calls, 2, '每小时上限按批次计，一次运行最多压 2 批');
        assert.equal(first.reason, 'hourly-cap');
        // 同一小时再触发：被上限拦住（会进入运行但压 0 批）
        const capped = await runtime.maybeRun(1000);
        assert.equal(capped.advanced, false);
        assert.equal(capped.reason, 'hourly-cap');
        // 下一小时恢复
        now += 3_600_000;
        const next = await runtime.maybeRun(1000);
        assert.equal(next.advanced, true);
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
        const runtime = runtimeOf(service, () => 10_000, { throttleMs: 0, hourlyCap: 0, maxBatchesPerRun: 3 });
        const result = await runtime.maybeRun(100);
        assert.equal(result.batches, 3);
        assert.equal(state.calls, 3);
    },

    async testCompactionRuntimeFailureBackoff() {
        let now = 10_000;
        const { service } = makeFake({ advanced: false, reason: 'summary-error' });
        const runtime = runtimeOf(service, () => now, { throttleMs: 0, hourlyCap: 10 });
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
        const runtime = runtimeOf(service, () => now, { throttleMs: 60_000, hourlyCap: 0 });
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
