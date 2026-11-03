// v7 归档控制器单测：双水位 A/B/C、标记块、硬切兜底、A 目标、报错归档、待机零 LLM、单飞。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import { ArchiveController } from '../src/context/archive_controller';
import type { EventInput } from '../src/context/events';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { ContextService } from '../src/context/service';
import { resolveArchiveWatermarks } from '../src/utils/context_limits';

class FakeStorage {
    map = new Map<string, string>();
    get(key: string): string {
        if (!this.map.has(key)) throw new Error(`key not found: ${key}`);
        return this.map.get(key)!;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

const ESTIMATE = 10;
let storage = new FakeStorage();
let sidCounter = 0;

function installHost(): void {
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => Date.now() },
        fetch: (() => { throw new Error('no fetch in unit test'); }) as any,
        ext: {} as any,
    });
}

function resetEnv(): void {
    storage = new FakeStorage();
    installHost();
    sidCounter += 1;
}

function sid(): string {
    return `QQ-Group:archive-controller-${sidCounter}`;
}

/** 交替 user/assistant，确保每条消息是独立单元（连续 user 会被合并成一个单元）。 */
function alternatingInputs(count: number, offset = 0): EventInput[] {
    const out: EventInput[] = [];
    for (let i = 0; i < count; i++) {
        const seqHint = offset + i + 1;
        if (i % 2 === 0) {
            out.push({ kind: 'user', uid: 'QQ:1', msgId: `m${seqHint}`, parts: [{ type: 'text', text: `消息${seqHint}` }] } as EventInput);
        } else {
            out.push({ kind: 'assistant', msgId: `a${seqHint}`, parts: [{ type: 'text', text: `回复${seqHint}` }] } as EventInput);
        }
    }
    return out;
}

/** 连续 user（会被 segmentUnits 合并成一个单元），用于制造"单块超出硬切目标"的越界场景。 */
function consecutiveUsers(count: number, offset = 0): EventInput[] {
    const out: EventInput[] = [];
    for (let i = 0; i < count; i++) {
        const seqHint = offset + i + 1;
        out.push({ kind: 'user', uid: 'QQ:1', msgId: `m${seqHint}`, parts: [{ type: 'text', text: `合并${seqHint}` }] } as EventInput);
    }
    return out;
}

interface Harness {
    service: ContextService;
    controller: ArchiveController;
    calls: string[];
    facts: unknown[][];
    records: () => number;
}

function makeHarness(opts?: {
    summarize?: (input: { previousSummary: string; segmentText: string }) => Promise<{ summary: string; facts: unknown[] } | null>;
}): Harness {
    resetEnv();
    const service = ContextService.openSync(sid(), { estimateEventTokens: () => ESTIMATE });
    const calls: string[] = [];
    const facts: unknown[][] = [];
    const summarize = opts?.summarize ?? (async ({ segmentText }: { previousSummary: string; segmentText: string }) => {
        calls.push(segmentText);
        return { summary: `S${calls.length}`, facts: [] };
    });
    const controller = new ArchiveController({
        service,
        estimateEventTokens: () => ESTIMATE,
        estimateTextTokens: (text: string) => text.length,
        summarizeAndExtract: async (input) => {
            const out = await summarize(input);
            return out;
        },
        applyFacts: async f => { facts.push(f); },
    });
    return {
        service,
        controller,
        calls,
        facts,
        records: () => service.snapshot().records.filter(r => r.kind === 'summary').length,
    };
}

function append(service: ContextService, inputs: EventInput[]): void {
    service.getStore().append(inputs);
}

export const tests: Record<string, () => void | Promise<void>> = {
    testArchiveWatermarksContract() {
        const wm = resolveArchiveWatermarks(1000, 30);
        assert.equal(wm.L, 1000);
        assert.equal(wm.A, 300);
        assert.equal(wm.B, 950);
        assert.equal(wm.C, 1650);
        // 配置 0 / 非法保留强度走默认 30%
        assert.equal(resolveArchiveWatermarks(0, 30).A, 0);
        assert.equal(resolveArchiveWatermarks(1000, 0).A, 300);
    },

    testArchiveControllerBTriggerToATarget() {
        const h = makeHarness();
        append(h.service, alternatingInputs(96)); // T = 960，B=950 ≤ T < L=1000
        h.controller.beforeRequest({ L: 1000, retainPercent: 30 });
        assert.equal(h.service.head().archivedThrough, 0, 'B≤T<L 不应硬切');
        h.controller.afterRequestSent();
        return h.controller.waitForSummary().then(() => {
            const head = h.service.head();
            assert.equal(h.calls.length, 1, '一次总结任务（单批装得下）');
            assert.ok(head.summarizedThrough > 0, 'B 触发应产生摘要');
            assert.ok(head.unarchivedTokens <= 300, `总结后未归档原文应 ≤A（实际 ${head.unarchivedTokens}）`);
            assert.equal(head.archivedThrough, head.summarizedThrough, '总结完成即归档（不变式）');
            assert.equal(h.records(), 1, '只产生一条滚动摘要');
            const record = h.service.snapshot().records.find(r => r.kind === 'summary') as { fromSeq: number; toSeq: number };
            assert.equal(record.fromSeq, 1, '滚动摘要从 epochStart 开始（无覆盖空洞）');
        });
    },

    testArchiveControllerTAboveLContinuesFromCb() {
        const h = makeHarness();
        append(h.service, alternatingInputs(125)); // T = 1250 ≥ L=1005
        h.controller.beforeRequest({ L: 1005, retainPercent: 30 }); // A=301 B=954
        const cutTo = h.service.head().archivedThrough;
        assert.ok(cutTo > 0, 'T≥L 必须先硬切');
        const tAfterCut = h.controller.estimateT();
        assert.ok(tAfterCut >= 954 && tAfterCut < 1005, `切后应落在 B≤T<L（实际 T=${tAfterCut}）`);
        h.controller.afterRequestSent();
        return h.controller.waitForSummary().then(() => {
            const head = h.service.head();
            assert.ok(head.summarizedThrough > cutTo, '切后 B≤T<L：总结应从最旧未总结处继续（含 Cb）');
            assert.ok(head.unarchivedTokens <= 301, `总结后剩余原文应 ≤A（实际 ${head.unarchivedTokens}）`);
            assert.equal(h.records(), 1);
        });
    },

    testArchiveControllerTAboveLOnlySummarizesCbWhenBelowB() {
        const h = makeHarness();
        // 70 条连续 user 合并为一个 700-token 单元；随后 40 条交替消息（首条 user 会并入同一单元）
        append(h.service, consecutiveUsers(70));
        append(h.service, alternatingInputs(40, 70));
        h.controller.beforeRequest({ L: 1000, retainPercent: 30 }); // B=950 A=300
        const cutTo = h.service.head().archivedThrough;
        assert.equal(cutTo, 71, '整块硬切：merged 单元 710 token 一次切掉');
        const tAfterCut = h.controller.estimateT();
        assert.equal(tAfterCut, 390);
        assert.ok(tAfterCut < 950, '切后 T<B');
        h.controller.afterRequestSent();
        return h.controller.waitForSummary().then(() => {
            const head = h.service.head();
            assert.equal(head.summarizedThrough, 71, 'T<B 时只总结 Cb，不再总结活动上下文');
            assert.equal(head.unarchivedTokens, 390, '活动上下文保持不动');
            assert.equal(h.records(), 1);
        });
    },

    testArchiveControllerBelowBDoesNothing() {
        const h = makeHarness();
        append(h.service, alternatingInputs(90)); // T=900 < B=950
        h.controller.beforeRequest({ L: 1000, retainPercent: 30 });
        h.controller.afterRequestSent();
        return h.controller.waitForSummary().then(() => {
            assert.equal(h.calls.length, 0, 'T<B 不总结、不归档');
            assert.equal(h.service.head().summarizedThrough, 0);
            assert.equal(h.service.head().archivedThrough, 0);
        });
    },

    testArchiveControllerSummaryErrorArchivesMark() {
        const h = makeHarness({ summarize: async () => null });
        append(h.service, alternatingInputs(96));
        h.controller.beforeRequest({ L: 1000, retainPercent: 30 });
        h.controller.afterRequestSent();
        return h.controller.waitForSummary().then(() => {
            const head = h.service.head();
            assert.equal(head.summarizedThrough, 0, '报错不写摘要');
            assert.ok(head.archivedThrough > 0, '报错也必须归档标记块');
            assert.equal(h.records(), 0);
            assert.equal(h.facts.length, 0, '报错不写记忆 facts');
        });
    },

    testArchiveControllerIdleArchivesZeroLlm() {
        const h = makeHarness();
        append(h.service, alternatingInputs(10)); // 先跑一次请求拿到 L 水位缓存
        h.controller.beforeRequest({ L: 1000, retainPercent: 30 });
        h.controller.afterRequestSent();
        // T=100 < B：不会总结
        // 待机继续涨到 C=1650 以上
        append(h.service, alternatingInputs(170)); // 总 T=1800 ≥ C
        const archived = h.controller.onIdleAppend();
        const head = h.service.head();
        assert.equal(archived, true, 'T≥C 应触发待机归档');
        assert.equal(h.calls.length, 0, '待机归档零 LLM');
        assert.equal(head.summarizedThrough, 0, '待机不写摘要');
        assert.equal(h.records(), 0);
        assert.equal(h.facts.length, 0, '待机不写记忆');
        assert.ok(head.unarchivedTokens <= 1000, `待机归档后应 T≤L（实际 ${head.unarchivedTokens}）`);
        assert.ok(head.archivedThrough > 0);
    },

    async testArchiveControllerUnitSpanningSummaryBoundary() {
        const h = makeHarness();
        append(h.service, consecutiveUsers(31)); // seq1-31 合并成一个 310-token 单元
        const first = await h.controller.archiveNow({ L: 1000, retainPercent: 30 });
        assert.equal(first.advanced, true);
        const through1 = h.service.head().summarizedThrough;
        assert.equal(through1, 31);

        // 再追加连续 user（seq32-62）：segmentUnits 会把 1-62 合并成同一个单元
        append(h.service, consecutiveUsers(31, 31));
        const second = await h.controller.archiveNow({ L: 1000, retainPercent: 30 });
        assert.equal(second.advanced, true, '跨摘要边界的合并单元应能继续总结，不得误判 missing-history');
        assert.equal(h.service.head().summarizedThrough, 62);
        assert.ok(h.calls.length >= 2);
    },

    async testArchiveControllerManualArchiveToATarget() {
        const h = makeHarness();
        append(h.service, alternatingInputs(96)); // T=960
        const result = await h.controller.archiveNow({ L: 1000, retainPercent: 30 });
        assert.equal(result.advanced, true);
        assert.ok((result.batches ?? 0) >= 1);
        const head = h.service.head();
        assert.ok(head.unarchivedTokens <= 300, `手动 archive 应保留 ≤A（实际 ${head.unarchivedTokens}）`);
        assert.equal(head.archivedThrough, head.summarizedThrough, '提交即归档（不变式）');
        assert.equal(h.records(), 1);
        // 已无「未归档原文超过 A」时再次手动 = 空操作
        const again = await h.controller.archiveNow({ L: 1000, retainPercent: 30 });
        assert.equal(again.advanced, false);
        assert.equal(again.reason, 'nothing-to-do');
    },

    async testArchiveControllerSingleFlight() {
        let release: (() => void) | null = null;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let callCount = 0;
        const h = makeHarness({
            summarize: async () => {
                callCount += 1;
                await gate;
                return { summary: 'S', facts: [] };
            },
        });
        append(h.service, alternatingInputs(96));
        h.controller.beforeRequest({ L: 1000, retainPercent: 30 });
        h.controller.afterRequestSent();
        h.controller.afterRequestSent(); // 第二次请求：总结仍在飞 → 不得重复启动
        assert.equal(h.controller.isSummarizing(), true, '任务应已同步登记为在飞');
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(callCount, 1, '同一会话同时最多一个总结任务');
        release!();
        await h.controller.waitForSummary();
        assert.equal(callCount, 1);
        assert.equal(h.records(), 1);
    },
};
