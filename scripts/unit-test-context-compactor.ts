// Context v2 滚动摘要器（compact/compactor）单元测试。
// 纯逻辑：注入 summarizer/estimator/时钟；不依赖 seal/store/Config。
import assert from 'node:assert/strict';

import { Backoff, compactOnce, shouldCompact } from '../src/context/compact/compactor';
import type { CompactDeps, CompactOptions, CompactResult } from '../src/context/compact/compactor';
import type {
    AssistantEvent,
    ConversationEvent,
    RecordEntry,
    SummaryRecord,
    ToolCallEvent,
    ToolResultEvent,
    UserEvent,
} from '../src/context/events';
import { createEmptyHead } from '../src/context/head';
import type { ContextHead } from '../src/context/head';

// ---------------- 构造工具 ----------------

function eventBase(seq: number, eventId = `x:${seq}`) {
    return { seq, eventId, at: seq * 10, recvAt: seq * 10 };
}

function evUser(seq: number, text = `u${seq}`): UserEvent {
    return {
        ...eventBase(seq, `u:m${seq}`),
        kind: 'user',
        uid: 'QQ:1',
        msgId: `m${seq}`,
        parts: [{ type: 'text', text }],
    };
}

function evAssistant(seq: number, text = `a${seq}`): AssistantEvent {
    return {
        ...eventBase(seq, `a:m${seq}`),
        kind: 'assistant',
        msgId: `am${seq}`,
        parts: [{ type: 'text', text }],
    };
}

function evCall(seq: number, turnId: string, callId: string): ToolCallEvent {
    return {
        ...eventBase(seq, `tc:${callId}:${callId}`),
        kind: 'tool_call',
        turnId,
        groupId: callId,
        callId,
        name: 'web_search',
        args: '{}',
    };
}

function evResult(seq: number, turnId: string, callId: string, text = `r${seq}`): ToolResultEvent {
    return {
        ...eventBase(seq, `tr:${callId}:${callId}`),
        kind: 'tool_result',
        turnId,
        groupId: callId,
        callId,
        parts: [{ type: 'text', text }],
    };
}

function recSummary(id: string, fromSeq: number, toSeq: number, text: string, epoch = 1): SummaryRecord {
    return { id, at: toSeq, kind: 'summary', epoch, fromSeq, toSeq, text };
}

function makeHead(overrides: Partial<ContextHead> = {}): ContextHead {
    return { ...createEmptyHead(), ...overrides };
}

const OPTS: CompactOptions = { batchTokens: 1000 };

/** 固定权重的事件估算器（未列出的按 fallback，缺省 10） */
function weights(map: Record<number, number> = {}, fallback = 10): (event: ConversationEvent) => number {
    return (event: ConversationEvent) => (map[event.seq] === undefined ? fallback : map[event.seq]);
}

interface Harness {
    deps: CompactDeps;
    calls: string[];
    result: (text: string | null | undefined) => void;
    failWith: (error: Error) => void;
}

function harness(estimateEventTokens: (event: ConversationEvent) => number = weights()): Harness {
    const calls: string[] = [];
    let mode: { kind: 'ok'; text: string | null | undefined } | { kind: 'throw'; error: Error } = { kind: 'ok', text: '摘要A' };
    const deps: CompactDeps = {
        summarize: (text: string) => {
            calls.push(text);
            if (mode.kind === 'throw') throw mode.error;
            return mode.text;
        },
        estimateEventTokens,
        now: () => 1000,
        newRecordId: info => `rec:${info.epoch}:${info.toSeq}`,
    };
    return {
        deps,
        calls,
        result: (text: string | null | undefined) => { mode = { kind: 'ok', text }; },
        failWith: (error: Error) => { mode = { kind: 'throw', error }; },
    };
}

async function runCompact(
    events: readonly ConversationEvent[],
    records: readonly RecordEntry[],
    head: ContextHead,
    h: Harness,
    opts: CompactOptions = OPTS,
): Promise<CompactResult> {
    return compactOnce({ events, records, head }, opts, h.deps);
}

// ---------------- 测试 ----------------

export const tests: Record<string, () => void | Promise<void>> = {
    async testCompactorAdvancesBasic() {
        const h = harness();
        const events = [evUser(1, '你好'), evUser(2, '在吗'), evAssistant(3, '在的')];
        const head = makeHead({ nextSeq: 4, summarizedThrough: 0, unsummarizedTokens: 30 });
        const result = await runCompact(events, [], head, h);

        assert.equal(result.advanced, true);
        assert.equal(result.reason, undefined);
        assert.ok(result.record);
        assert.equal(result.record!.kind, 'summary');
        assert.equal(result.record!.fromSeq, 1, 'rolling summary 从 epochStartSeq 开始');
        assert.equal(result.record!.toSeq, 3, '覆盖到段末单元 toSeq');
        assert.equal(result.record!.text, '摘要A');
        assert.equal(result.record!.epoch, 1);
        assert.equal(result.record!.at, 1000);
        assert.equal(result.record!.id, 'rec:1:3');
        assert.equal(result.through, 3);
        assert.equal(result.batch?.unitCount, 2, 'user1+user2 合并为一个单元，assistant 一个');
        assert.equal(result.batch?.tokens, 30);
        assert.equal(result.batch?.fromSeq, 1);
        assert.equal(result.unsummarizedTokens, 0, '全部事件已进摘要');
        assert.equal(h.calls.length, 1);
        assert.ok(h.calls[0].includes('你好') && h.calls[0].includes('在吗') && h.calls[0].includes('在的'));
        assert.ok(h.calls[0].includes('QQ:1'), '摘要输入带说话者 id');
        assert.ok(result.inputChars > 0);
        assert.equal(result.truncated, false);
    },

    async testCompactorBatchLimitRespectsUnitBoundary() {
        const h = harness();
        const events = [evUser(1, 'u1'), evAssistant(2, 'a2'), evUser(3, 'u3'), evAssistant(4, 'a4')];
        const head = makeHead({ nextSeq: 5, summarizedThrough: 0, unsummarizedTokens: 40 });
        const result = await runCompact(events, [], head, h, { batchTokens: 25 });

        assert.equal(result.advanced, true);
        assert.equal(result.record!.toSeq, 2, '第三单元会超出 batch → 切在单元边界');
        assert.equal(result.batch!.unitCount, 2);
        assert.equal(result.batch!.tokens, 20);
        assert.equal(result.unsummarizedTokens, 20, '余下两个单元各 10 token');
        assert.ok(h.calls[0].includes('u1') && h.calls[0].includes('a2'));
        assert.equal(h.calls[0].includes('u3'), false, '未选中的单元不进摘要输入');
    },

    async testCompactorFirstOverBatchUnitStillTaken() {
        const h = harness(weights({ 1: 40, 2: 40, 3: 40, 4: 40 }));
        const events = [evCall(1, 't1', 'c1'), evCall(2, 't1', 'c2'), evResult(3, 't1', 'c1'), evResult(4, 't1', 'c2')];
        const head = makeHead({ nextSeq: 5, summarizedThrough: 0, unsummarizedTokens: 160 });
        const result = await runCompact(events, [], head, h, { batchTokens: 10 });

        assert.equal(result.advanced, true);
        assert.equal(result.batch!.unitCount, 1, '工具组只能整组送入');
        assert.equal(result.batch!.tokens, 160);
        assert.equal(result.batch!.toSeq, 4, '整组（含全部结果）');
        assert.equal(result.record!.toSeq, 4);
        assert.equal(result.unsummarizedTokens, 0);
    },

    async testCompactorNeverSplitsToolGroup() {
        // 预算够：user 单元 + 工具组整组
        const enough = harness(weights({ 1: 10, 2: 20, 3: 20 }));
        const events = [evUser(1, '问'), evCall(2, 't1', 'c1'), evResult(3, 't1', 'c1', '答')];
        const head = makeHead({ nextSeq: 4, summarizedThrough: 0, unsummarizedTokens: 50 });
        const ok = await runCompact(events, [], head, enough, { batchTokens: 50 });
        assert.equal(ok.advanced, true);
        assert.equal(ok.batch!.unitCount, 2);
        assert.equal(ok.record!.toSeq, 3);
        assert.ok(enough.calls[0].includes('[tool call web_search]') && enough.calls[0].includes('[tool result c1]'));

        // 预算不够：工具组整体推迟，绝不只取调用或只取结果
        const tight = harness(weights({ 1: 10, 2: 20, 3: 20 }));
        const partial = await runCompact(events, [], head, tight, { batchTokens: 35 });
        assert.equal(partial.record!.toSeq, 1, '只压 user 单元，工具组整组留待下次');
        assert.equal(partial.batch!.unitCount, 1);
        assert.equal(partial.unsummarizedTokens, 40);
    },

    async testCompactorRendersIncompleteGroupAndOrphan() {
        const h = harness();
        // 不完整工具组（call 无结果）+ 孤儿结果
        const events = [
            evCall(1, 't1', 'c1'),
            evResult(2, 'tX', 'c9', '孤儿结果'),
        ];
        const head = makeHead({ nextSeq: 3, summarizedThrough: 0, unsummarizedTokens: 20 });
        const result = await runCompact(events, [], head, h);
        assert.equal(result.advanced, true);
        assert.ok(h.calls[0].includes('[unfinished tool calls: c1]'), '不完整组在摘要输入里显式标记');
        assert.ok(h.calls[0].includes('孤儿结果'), '孤儿结果照常进摘要输入');
    },

    async testCompactorEmptySummaryDoesNotAdvance() {
        const h = harness();
        const events = [evUser(1, '你好')];
        const head = makeHead({ nextSeq: 2, summarizedThrough: 0, unsummarizedTokens: 10 });
        h.result(null);
        const empty = await runCompact(events, [], head, h);
        assert.equal(empty.advanced, false);
        assert.equal(empty.reason, 'empty-summary');
        assert.equal(empty.record, null);
        assert.equal(empty.through, 0, '失败不推进水位');
        assert.equal(empty.batch?.toSeq, 1);
        assert.equal(h.calls.length, 1);

        h.result('   ');
        const blank = await runCompact(events, [], head, h);
        assert.equal(blank.advanced, false);
        assert.equal(blank.reason, 'empty-summary');

        h.failWith(new Error('模型超时'));
        const failed = await runCompact(events, [], head, h);
        assert.equal(failed.advanced, false);
        assert.equal(failed.reason, 'summary-error');
        assert.equal(failed.error, '模型超时');
        assert.equal(failed.through, 0, '异常同样不推进');
    },

    async testCompactorIdempotentAfterCommit() {
        const h = harness();
        const events = [evUser(1, '你好'), evAssistant(2, '在的')];
        const head = makeHead({ nextSeq: 3, summarizedThrough: 0, unsummarizedTokens: 20 });
        const first = await runCompact(events, [], head, h);
        assert.equal(first.advanced, true);
        const firstText = first.record!.text;

        // 调用方提交后：head.summarizedThrough 推进 + 记录入账
        const committedHead = makeHead({
            nextSeq: 3,
            summarizedThrough: first.through,
            unsummarizedTokens: first.unsummarizedTokens,
        });
        const committedRecords: RecordEntry[] = [first.record!];
        const second = await runCompact(events, committedRecords, committedHead, h);
        assert.equal(second.advanced, false);
        assert.equal(second.reason, 'no-unsummarized-events');
        assert.equal(second.record, null);
        assert.equal(second.through, first.through);
        assert.equal(h.calls.length, 1, '幂等：不再调用摘要器');

        // 同输入、未提交（模拟调用方忘了 commit）：结果与第一次一致，不会产生覆盖性差异
        const again = await runCompact(events, [], head, h);
        assert.equal(again.advanced, true);
        assert.equal(again.record!.toSeq, first.record!.toSeq);
        assert.equal(again.record!.text, firstText);
        assert.equal(again.through, first.through);
    },

    async testCompactorAlreadySummarizedGuard() {
        // head 落后但已有摘要覆盖到候选末尾（异常/并发恢复场景）：不重复压缩
        const h = harness();
        const events = [evUser(1, '旧内容'), evUser(2, '也算旧内容')];
        const records: RecordEntry[] = [recSummary('old-sum', 1, 2, '旧摘要')];
        const head = makeHead({ nextSeq: 3, summarizedThrough: 1, unsummarizedTokens: 10 });
        const result = await runCompact(events, records, head, h);
        assert.equal(result.advanced, false);
        assert.equal(result.reason, 'already-summarized');
        assert.equal(result.batch?.toSeq, 2);
        assert.equal(h.calls.length, 0, '守卫命中时不调用摘要器');
    },

    async testCompactorIncludesPreviousSummaryInput() {
        const h = harness();
        const events = [evUser(3, '新内容1'), evAssistant(4, '新内容2')];
        const records: RecordEntry[] = [recSummary('s1', 1, 2, '旧摘要正文')];
        const head = makeHead({ nextSeq: 5, summarizedThrough: 2, unsummarizedTokens: 20 });
        const result = await runCompact(events, records, head, h);
        assert.equal(result.advanced, true);
        assert.equal(result.record!.fromSeq, 1, '滚动摘要始终从 epoch 起点声明覆盖');
        assert.equal(result.record!.toSeq, 4);
        assert.ok(h.calls[0].includes('旧摘要正文'), '输入包含上一条滚动摘要');
        assert.ok(h.calls[0].indexOf('旧摘要正文') < h.calls[0].indexOf('新内容1'), '旧摘要在前');
    },

    async testCompactorSkipsRedactedEvents() {
        const h = harness();
        const events = [evUser(1, '秘密内容'), evUser(2, '保留内容')];
        const records: RecordEntry[] = [
            { id: 'r1', at: 1, kind: 'redact', epoch: 1, fromSeq: 1, toSeq: 1, target: 'user' },
        ];
        const head = makeHead({ nextSeq: 3, summarizedThrough: 0, unsummarizedTokens: 20 });
        const result = await runCompact(events, records, head, h);
        assert.equal(result.advanced, true);
        assert.equal(result.record!.toSeq, 2);
        assert.equal(h.calls[0].includes('秘密内容'), false, '被 redact 的事件不进摘要');
        assert.ok(h.calls[0].includes('保留内容'));
    },

    async testCompactorTruncatesLongSummary() {
        const h = harness();
        const events = [evUser(1, '内容')];
        const head = makeHead({ nextSeq: 2, summarizedThrough: 0, unsummarizedTokens: 10 });
        h.result('长'.repeat(500));
        const limited = await runCompact(events, [], head, h, { batchTokens: 100, summaryMaxChars: 100 });
        assert.equal(limited.advanced, true);
        assert.equal(limited.truncated, true);
        assert.ok(limited.record!.text.length <= 100, `摘要必须 ≤ 上限，实际 ${limited.record!.text.length}`);
        assert.ok(limited.record!.text.endsWith('… (summary too long; truncated)'));

        // summaryMaxChars<=0 = 不截断
        const unlimited = await runCompact(events, [], head, h, { batchTokens: 100, summaryMaxChars: 0 });
        assert.equal(unlimited.truncated, false);
        assert.equal(unlimited.record!.text.length, 500);
    },

    async testCompactorEmptyInputsAndEpochStart() {
        const h = harness();
        const empty = await runCompact([], [], makeHead({ nextSeq: 1 }), h);
        assert.equal(empty.advanced, false);
        assert.equal(empty.reason, 'no-unsummarized-events');
        assert.equal(h.calls.length, 0);

        // epoch 重置后，旧事件不可见
        const epochHead = makeHead({ epoch: 2, epochStartSeq: 10, nextSeq: 35, summarizedThrough: 9, unsummarizedTokens: 100 });
        const epochRecords: RecordEntry[] = [{ id: 'e1', at: 1, kind: 'epoch', epoch: 2, startSeq: 10 }];
        const old = await runCompact([evUser(1, '旧'), evAssistant(2, '旧')], epochRecords, epochHead, h);
        assert.equal(old.advanced, false);
        assert.equal(old.reason, 'no-unsummarized-events');
        assert.equal(h.calls.length, 0);

        // 新 epoch 内正常推进，fromSeq=epochStartSeq
        const epochEvents = [evUser(10, '新世代')];
        const advanced = await runCompact(epochEvents, epochRecords, epochHead, h);
        assert.equal(advanced.advanced, true);
        assert.equal(advanced.record!.fromSeq, 10);
        assert.equal(advanced.record!.epoch, 2);
        assert.equal(advanced.record!.toSeq, 10);
    },

    async testCompactorInvalidBatch() {
        const h = harness();
        const events = [evUser(1, '你好')];
        const head = makeHead({ nextSeq: 2, summarizedThrough: 0, unsummarizedTokens: 10 });
        for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            const result = await runCompact(events, [], head, h, { batchTokens: bad });
            assert.equal(result.advanced, false);
            assert.equal(result.reason, 'invalid-batch');
            assert.equal(result.batch, null);
        }
        assert.equal(h.calls.length, 0);
    },

    async testCompactorMissingHistoryGuard() {
        // 未摘要区间的事件不在输入窗口里（store 只加载最近页）：不能谎报 fromSeq=epochStart 的覆盖
        const h = harness();
        const head = makeHead({ nextSeq: 6, summarizedThrough: 1, unsummarizedTokens: 30 });
        const missing = await runCompact([evUser(5, '窗口内第一条')], [], head, h);
        assert.equal(missing.advanced, false);
        assert.equal(missing.reason, 'missing-history');
        assert.equal(h.calls.length, 0, '历史缺口时不调用摘要器');

        // 输入里包含 startSeq 之前的事件（已摘要）→ 正常推进
        const ok = await runCompact([evUser(1, '旧'), evUser(5, '新')], [], head, h);
        assert.equal(ok.advanced, true);
        assert.equal(ok.record!.fromSeq, 1);
        assert.equal(ok.record!.toSeq, 5);
    },

    async testCompactorShouldCompact() {
        const base = makeHead({ nextSeq: 5, summarizedThrough: 2, unsummarizedTokens: 9000 });
        assert.equal(shouldCompact(base, 6000), true);
        assert.equal(shouldCompact(base, 9000), true);
        assert.equal(shouldCompact(base, 9001), false);
        assert.equal(shouldCompact(base, 0), false, '水位 0 = 关闭');
        assert.equal(shouldCompact(base, -1), false);
        assert.equal(shouldCompact(makeHead({ nextSeq: 5, summarizedThrough: 4 }), 1), false, '没有未摘要事件');
        assert.equal(shouldCompact(makeHead({ nextSeq: 5, summarizedThrough: 5 }), 1), false, '水位越界也不触发');
        assert.equal(shouldCompact(makeHead({ nextSeq: 1 }), 1), false, '还没有事件');
        assert.equal(shouldCompact(makeHead({ epochStartSeq: 10, nextSeq: 5 }), 1), false, 'epoch 起点晚于最后事件');
    },

    testCompactorBackoff() {
        const backoff = new Backoff();
        assert.equal(backoff.failureCount, 0);
        assert.equal(backoff.isBlocked(1000), false);
        assert.equal(backoff.remainingMs(1000), 0);

        const now = 1_000_000;
        assert.equal(backoff.fail(now), 5 * 60_000);
        assert.equal(backoff.isBlocked(now + 1000), true);
        assert.equal(backoff.remainingMs(now + 1000), 5 * 60_000 - 1000);
        assert.equal(backoff.fail(now), 15 * 60_000);
        assert.equal(backoff.fail(now), 60 * 60_000);
        assert.equal(backoff.fail(now), 60 * 60_000, '超过档位封顶');
        assert.equal(backoff.failureCount, 4);
        assert.equal(backoff.isBlocked(now + 60 * 60_000), false);

        backoff.reset();
        assert.equal(backoff.failureCount, 0);
        assert.equal(backoff.isBlocked(now), false);

        const custom = new Backoff({ delaysMs: [1000, 2000] });
        assert.equal(custom.delayMsFor(1), 1000);
        assert.equal(custom.delayMsFor(2), 2000);
        assert.equal(custom.delayMsFor(9), 2000, '自定义档位超出按最后一档');
    },
};
