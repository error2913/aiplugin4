// 压缩运行时编排单测：水位/节流/小时上限/退避/单飞/手动归档/flush 失败。
import assert from 'node:assert/strict';

import { CompactionRuntime } from '../src/context/compact/runtime';
import type { CompactResult } from '../src/context/compact/compactor';

interface FakeOptions {
    advanced?: boolean;
    reason?: string;
    flushOk?: boolean;
    defer?: boolean;
}

function makeFake(opts: FakeOptions = {}) {
    const state = {
        canCompact: true,
        calls: 0,
        flushes: 0,
        summaries: [] as string[],
        resolve: null as null | (() => void),
    };
    const service = {
        shouldCompact: () => state.canCompact,
        compact: async (_o: unknown, deps: { summarize: (text: string) => string }) => {
            state.calls++;
            state.summaries.push(deps.summarize('input'));
            if (opts.defer && state.calls === 1) {
                await new Promise<void>(resolve => { state.resolve = resolve; });
            }
            const result: CompactResult = {
                advanced: opts.advanced ?? true,
                reason: opts.reason,
                record: opts.advanced === false && opts.reason
                    ? null
                    : {
                        kind: 'summary',
                        id: `sum:${state.calls}`,
                        at: 1,
                        epoch: 1,
                        fromSeq: 1,
                        toSeq: 2,
                        text: '摘要',
                    },
                through: opts.advanced === false ? 0 : 2,
                unsummarizedTokens: 0,
                batch: null,
                inputChars: 0,
                truncated: false,
            };
            return result;
        },
        flush: async () => {
            state.flushes++;
            return { ok: opts.flushOk ?? true, error: opts.flushOk === false ? 'boom' : undefined };
        },
    };
    return { service, state };
}

function runtimeOf(service: any, now: () => number, extra: Partial<{ watermarkTokens: number; hourlyCap: number; throttleMs: number }> = {}) {
    return new CompactionRuntime({
        watermarkTokens: extra.watermarkTokens ?? 100,
        batchTokens: 100,
        hourlyCap: extra.hourlyCap ?? 3,
        throttleMs: extra.throttleMs ?? 1000,
    }, {
        service,
        summarize: () => '摘要',
        estimateEventTokens: () => 10,
        now,
    });
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testCompactionRuntimeAdvancesAndFlushes() {
        let now = 10_000;
        const { service, state } = makeFake();
        const runtime = runtimeOf(service, () => now);
        const result = await runtime.maybeRun();
        assert.equal(result.ran, true);
        assert.equal(result.advanced, true);
        assert.equal(result.flushed, true);
        assert.equal(state.calls, 1);
        assert.equal(state.flushes, 1);

        now += 500;
        const throttled = await runtime.maybeRun();
        assert.equal(throttled.ran, false);
        assert.equal(throttled.reason, 'throttled');
    },

    async testCompactionRuntimeHourlyCap() {
        let now = 10_000;
        const { service } = makeFake();
        const runtime = runtimeOf(service, () => now, { throttleMs: 0, hourlyCap: 2 });
        assert.equal((await runtime.maybeRun()).advanced, true);
        now += 1;
        assert.equal((await runtime.maybeRun()).advanced, true);
        now += 1;
        const capped = await runtime.maybeRun();
        assert.equal(capped.ran, false);
        assert.equal(capped.reason, 'hourly-cap');
        // 下一小时恢复
        now += 3_600_000;
        assert.equal((await runtime.maybeRun()).advanced, true);
    },

    async testCompactionRuntimeBacklogAndDisabled() {
        let now = 10_000;
        const { service, state } = makeFake();
        const runtime = runtimeOf(service, () => now);
        state.canCompact = false;
        assert.equal((await runtime.maybeRun()).reason, 'backlog-below-watermark');
        state.canCompact = true;
        const disabled = runtimeOf(service, () => now, { watermarkTokens: 0 });
        assert.equal((await disabled.maybeRun()).reason, 'disabled');
    },

    async testCompactionRuntimeFailureBackoff() {
        let now = 10_000;
        const { service } = makeFake({ advanced: false, reason: 'summary-error' });
        const runtime = runtimeOf(service, () => now, { throttleMs: 0, hourlyCap: 10 });
        const first = await runtime.maybeRun();
        assert.equal(first.advanced, false);
        assert.equal(first.reason, 'summary-error');
        now += 1000;
        const blocked = await runtime.maybeRun();
        assert.equal(blocked.ran, false);
        assert.equal(blocked.reason, 'backoff');
        now += 60 * 60 * 1000;
        const after = await runtime.maybeRun();
        assert.equal(after.advanced, false, '摘要仍失败，不推进');
    },

    async testCompactionRuntimeFlushFailure() {
        let now = 10_000;
        const { service } = makeFake({ flushOk: false });
        const runtime = runtimeOf(service, () => now);
        const result = await runtime.maybeRun();
        assert.equal(result.advanced, true);
        assert.equal(result.flushed, false);
        assert.ok(String(result.reason).includes('flush-failed'));
    },

    async testCompactionRuntimeSingleFlightAndManualArchive() {
        let now = 10_000;
        const { service, state } = makeFake({ defer: true });
        const runtime = runtimeOf(service, () => now, { throttleMs: 60_000, hourlyCap: 0 });
        const first = runtime.maybeRun();
        const second = await runtime.maybeRun();
        assert.equal(second.ran, false);
        assert.equal(second.reason, 'running');
        state.resolve!();
        assert.equal((await first).advanced, true);
        now += 1;
        // 手动归档忽略节流
        const manual = await runtime.archiveNow();
        assert.equal(manual.ran, true);
        assert.equal(manual.advanced, true);
    },
};
