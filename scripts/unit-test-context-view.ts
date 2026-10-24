// Context v2 视图层（view/units + view/records）单元测试。
// 纯函数、不依赖 seal/Config/storage；覆盖工具组原子、不完整组、乱序结果、edit/supersede/redact/epoch、
// 摘要选择与缺口，以及"可见性过滤 → 单元切分"的组合用法。
import assert from 'node:assert/strict';

import type {
    AssistantEvent,
    ConversationEvent,
    EditRecord,
    EpochResetRecord,
    RecordEntry,
    RedactRecord,
    SummaryRecord,
    SupersedeRecord,
    SystemEvent,
    ToolCallEvent,
    ToolResultEvent,
    UserEvent,
} from '../src/context/events';
import {
    estimateUnitTokens,
    estimateUnitsTokens,
    isTextualUnit,
    isToolUnit,
    segmentUnits,
} from '../src/context/view/units';
import {
    applyEdit,
    applyVisibility,
    buildRecordIndex,
    dedupKeyOfEvent,
    isVisible,
    latestSummary,
    summaryGap,
} from '../src/context/view/records';

// ---------------- 事件构造 ----------------

function eventBase(seq: number, eventId = `x:${seq}`) {
    return { seq, eventId, at: seq * 10, recvAt: seq * 10 };
}

function evUser(seq: number, text = `u${seq}`, origin?: 'self'): UserEvent {
    const event: UserEvent = {
        ...eventBase(seq, `u:m${seq}`),
        kind: 'user',
        uid: 'QQ:1',
        msgId: `m${seq}`,
        parts: [{ type: 'text', text }],
    };
    if (origin) event.origin = origin;
    return event;
}

function evAssistant(seq: number, text = `a${seq}`, reasoning?: string): AssistantEvent {
    const event: AssistantEvent = {
        ...eventBase(seq, `a:m${seq}`),
        kind: 'assistant',
        msgId: `am${seq}`,
        parts: [{ type: 'text', text }],
    };
    if (reasoning !== undefined) event.reasoning = reasoning;
    return event;
}

function evSystem(seq: number, text = `s${seq}`, dedupKey = `recall:${seq}`): SystemEvent {
    return {
        ...eventBase(seq, `e:${dedupKey}`),
        kind: 'event',
        systemName: '事件提示',
        parts: [{ type: 'text', text }],
    };
}

function evCall(seq: number, turnId: string, callId: string, groupId = callId): ToolCallEvent {
    return {
        ...eventBase(seq, `tc:${groupId}:${callId}`),
        kind: 'tool_call',
        turnId,
        groupId,
        callId,
        name: 'web_search',
        args: '{}',
    };
}

function evResult(seq: number, turnId: string, callId: string, text = `r${seq}`, groupId = callId): ToolResultEvent {
    return {
        ...eventBase(seq, `tr:${groupId}:${callId}`),
        kind: 'tool_result',
        turnId,
        groupId,
        callId,
        parts: [{ type: 'text', text }],
    };
}

// ---------------- 记录构造 ----------------

function recSummary(id: string, fromSeq: number, toSeq: number, text: string, epoch = 1, at = toSeq): SummaryRecord {
    return { id, at, kind: 'summary', epoch, fromSeq, toSeq, text };
}

function recEdit(id: string, seq: number, text: string, at = seq): EditRecord {
    return { id, at, kind: 'edit', seq, parts: [{ type: 'text', text }] };
}

function recSupersede(id: string, dedupKey: string, seq: number, at = seq): SupersedeRecord {
    return { id, at, kind: 'supersede', dedupKey, seq };
}

function recRedact(id: string, fromSeq: number, toSeq: number, target: RedactRecord['target'], epoch = 1, at = toSeq): RedactRecord {
    return { id, at, kind: 'redact', epoch, fromSeq, toSeq, target };
}

function recEpoch(id: string, epoch: number, startSeq: number, at: number): EpochResetRecord {
    return { id, at, kind: 'epoch', epoch, startSeq };
}

export const tests: Record<string, () => void | Promise<void>> = {
    // ---------------- 单元切分 ----------------

    testContextViewUnitsMergeUsersAndKinds() {
        const units = segmentUnits([evUser(1), evUser(2), evAssistant(3), evSystem(4), evUser(5)]);
        assert.equal(units.length, 4, '应合并相邻 user，其余各自成单元');
        assert.deepEqual(units.map(u => u.kind), ['user', 'assistant', 'event', 'user']);
        assert.equal(units[0].fromSeq, 1);
        assert.equal(units[0].toSeq, 2);
        assert.equal(units[0].events.length, 2);
        assert.equal(units[0].complete, true);
        assert.equal(units[1].fromSeq, 3);
        assert.equal(units[2].kind, 'event');
        assert.equal(units[3].fromSeq, 5, '系统事件打断 user 合并');
        assert.equal(isTextualUnit(units[0]), true);
        assert.equal(isToolUnit(units[0]), false);
    },

    testContextViewUnitsToolGroupAtomic() {
        const events = [evUser(1), evCall(2, 'turn1', 'c1'), evCall(3, 'turn1', 'c2'), evResult(4, 'turn1', 'c1'), evResult(5, 'turn1', 'c2'), evAssistant(6)];
        const units = segmentUnits(events);
        assert.equal(units.length, 3, '工具事件必须合成一个单元');
        assert.equal(units[1].kind, 'tool_group');
        assert.equal(units[1].fromSeq, 2);
        assert.equal(units[1].toSeq, 5);
        assert.equal(units[1].complete, true);
        assert.equal(units[1].turnId, 'turn1');
        assert.equal(units[1].missingCallIds, undefined);
        // 渲染顺序：全部调用（按 seq），再按调用顺序排列各自的结果
        assert.deepEqual(units[1].events.map(e => (e as { seq: number }).seq), [2, 3, 4, 5]);
        assert.equal(isToolUnit(units[1]), true);
        assert.equal(units.filter(u => u.kind === 'tool_group').length, 1, '不得拆成两个可选单元');
    },

    testContextViewUnitsUnorderedResults() {
        // 结果乱序到达 + 输入数组乱序：都应按 seq 归位成同一个完整组
        const events = [evResult(5, 'turn1', 'c2'), evCall(2, 'turn1', 'c1'), evResult(4, 'turn1', 'c1'), evCall(3, 'turn1', 'c2')];
        const units = segmentUnits(events);
        assert.equal(units.length, 1);
        assert.equal(units[0].kind, 'tool_group');
        assert.equal(units[0].complete, true);
        assert.deepEqual(units[0].events.map(e => (e as { seq: number }).seq), [2, 3, 4, 5]);
    },

    testContextViewUnitsCallWithoutResult() {
        const events = [evCall(2, 'turn1', 'c1'), evCall(3, 'turn1', 'c2'), evResult(4, 'turn1', 'c1')];
        const units = segmentUnits(events);
        assert.equal(units.length, 1);
        assert.equal(units[0].kind, 'tool_group');
        assert.equal(units[0].complete, false);
        assert.deepEqual(units[0].missingCallIds, ['c2']);
        assert.deepEqual(units[0].events.map(e => (e as { seq: number }).seq), [2, 3, 4], '缺结果的调用保留在组内，由编译层降级');
    },

    testContextViewUnitsOrphanResult() {
        // 无调用 → 单独 orphan_result 文本型单元
        const units = segmentUnits([evUser(1), evResult(2, 'turnX', 'c9')]);
        assert.equal(units.length, 2);
        assert.equal(units[1].kind, 'orphan_result');
        assert.equal(units[1].complete, false);
        assert.equal(isTextualUnit(units[1]), true);
        assert.equal(units[1].events.length, 1);

        // 同一 group 的多个孤儿结果合成一个单元
        const grouped = segmentUnits([evResult(2, 'turnX', 'c9'), evResult(3, 'turnX', 'c9')]);
        assert.equal(grouped.length, 1);
        assert.equal(grouped[0].kind, 'orphan_result');
        assert.deepEqual(grouped[0].events.map(e => (e as { seq: number }).seq), [2, 3]);

        // 同 turn 内既有配对又有孤儿：组完整 + 单独孤儿单元
        const mixed = segmentUnits([evCall(1, 'turn1', 'c1'), evResult(2, 'turn1', 'c1'), evResult(3, 'turn1', 'c9')]);
        assert.equal(mixed.length, 2);
        assert.equal(mixed[0].kind, 'tool_group');
        assert.equal(mixed[0].complete, true);
        assert.equal(mixed[1].kind, 'orphan_result');
    },

    testContextViewUnitsUserAfterToolGroupStaysSeparate() {
        const units = segmentUnits([evUser(1), evCall(2, 'turn1', 'c1'), evResult(3, 'turn1', 'c1'), evUser(4)]);
        assert.deepEqual(units.map(u => u.kind), ['user', 'tool_group', 'user']);
        assert.equal(units[2].fromSeq, 4);
        assert.equal(units[2].events.length, 1, '跨过工具组的 user 消息不与最早 user 合并');
    },

    testContextViewUnitsDedupeAndTokenEstimate() {
        const user = evUser(1);
        const units = segmentUnits([user, user, evAssistant(2)]);
        assert.equal(units.length, 2, '重复 seq 只保留首个');
        assert.equal(units[0].events.length, 1);

        let calls = 0;
        const estimate = (event: ConversationEvent): number => {
            calls++;
            return event.kind === 'user' ? 7 : 3;
        };
        assert.equal(estimateUnitTokens(units[0], estimate), 7);
        assert.equal(estimateUnitTokens(units[1], estimate), 3);
        calls = 0;
        assert.equal(estimateUnitsTokens(units, estimate), 10);
        assert.equal(calls, 2, 'estimateUnitsTokens 对每个事件只估算一次');
    },

    // ---------------- 记录索引 ----------------

    testContextViewRecordsEpoch() {
        const events = [1, 2, 3, 4, 5, 6].map(seq => evUser(seq));
        const index = buildRecordIndex([recEpoch('e1', 1, 1, 10), recEpoch('e2', 2, 5, 20)]);
        assert.equal(index.epoch, 2);
        assert.equal(index.epochStartSeq, 5);
        assert.deepEqual(applyVisibility(events, index).map(e => e.seq), [5, 6]);
        assert.equal(isVisible(events[3], index), false);
        assert.equal(isVisible(events[4], index), true);
        assert.equal(index.epochRecord?.id, 'e2');

        // 同 epoch 多条 reset：取 at 最新者
        const later = buildRecordIndex([recEpoch('e2', 2, 5, 20), recEpoch('e3', 2, 7, 30)]);
        assert.equal(later.epochStartSeq, 7, '同 epoch 取最后到达的 reset');

        // epoch 号最大者优先，与 at 无关（旧 epoch 的记录即使 at 更新也不能回退世代）
        const higherEpochEarlierAt = buildRecordIndex([recEpoch('e2', 2, 5, 100), recEpoch('e3', 3, 9, 10)]);
        assert.equal(higherEpochEarlierAt.epoch, 3);
        assert.equal(higherEpochEarlierAt.epochStartSeq, 9);
        assert.equal(higherEpochEarlierAt.epochRecord?.id, 'e3');

        // 空记录 → 默认 epoch1 / start1
        const empty = buildRecordIndex([]);
        assert.equal(empty.epoch, 1);
        assert.equal(empty.epochStartSeq, 1);
        assert.equal(empty.epochRecord, null);
        assert.equal(applyVisibility(events, empty).length, 6);
    },

    testContextViewRecordsRedact() {
        const user1 = evUser(1);
        const assistant2 = evAssistant(2);
        const user3 = evUser(3);
        const call4 = evCall(4, 'turn1', 'c1');
        const result5 = evResult(5, 'turn1', 'c1');
        const events = [user1, assistant2, user3, call4, result5];

        const hideUser = buildRecordIndex([recRedact('r1', 2, 3, 'user')]);
        assert.equal(isVisible(user1, hideUser), true);
        assert.equal(isVisible(assistant2, hideUser), true, 'hide user 不影响 assistant');
        assert.equal(isVisible(user3, hideUser), false);
        assert.deepEqual(applyVisibility(events, hideUser).map(e => e.seq), [1, 2, 4, 5]);

        const hideAssistant = buildRecordIndex([recRedact('r2', 4, 5, 'assistant')]);
        assert.equal(isVisible(call4, hideAssistant), false, '助手侧 redact 同时隐藏工具调用');
        assert.equal(isVisible(result5, hideAssistant), false, '以及工具结果，避免孤儿');
        assert.equal(isVisible(assistant2, hideAssistant), true, '区间外不受影响');

        const hideAll = buildRecordIndex([recRedact('r3', 1, 1, 'all')]);
        assert.equal(isVisible(user1, hideAll), false);

        // 旧 epoch 的 redact 不生效
        const stale = buildRecordIndex([recEpoch('e2', 2, 1, 20), recRedact('r4', 1, 6, 'all', 1, 5)]);
        assert.equal(isVisible(user1, stale), true, '旧 epoch 的 redact 只做审计');

        // 机器人自录消息（origin=self）归 assistant 侧
        const self = evUser(6, 'bot', 'self');
        const hideAssistant2 = buildRecordIndex([recRedact('r5', 6, 6, 'assistant')]);
        assert.equal(isVisible(self, hideAssistant2), false, 'hide assistant 应隐藏机器人自录消息');
        const hideUser2 = buildRecordIndex([recRedact('r6', 6, 6, 'user')]);
        assert.equal(isVisible(self, hideUser2), true, 'hide user 不应隐藏机器人自录消息');
    },

    testContextViewRecordsSupersede() {
        const dup1 = evSystem(1, '旧事件', 'recall:1');
        const dup2 = evSystem(4, '新事件', 'recall:1');
        const index = buildRecordIndex([recSupersede('s1', 'recall:1', 1), recSupersede('s2', 'recall:1', 4)]);
        assert.equal(dedupKeyOfEvent(dup1), 'recall:1');
        assert.equal(dedupKeyOfEvent(dup2), 'recall:1');
        assert.equal(isVisible(dup1, index), false, '更早副本被覆盖');
        assert.equal(isVisible(dup2, index), true, '最新 seq 保留');

        // 后到记录（更大 seq）赢：同时存在 4 与 6 → 4 也不可见
        const both = buildRecordIndex([recSupersede('s1', 'recall:1', 4), recSupersede('s2', 'recall:1', 6)]);
        assert.equal(isVisible(dup2, both), false);

        // user 事件按 eventId 去重
        const userA = evUser(2);
        const superseded = buildRecordIndex([recSupersede('s3', 'u:m2', 3)]);
        assert.equal(isVisible(userA, superseded), false);

        // 空 dedupKey 的记录被忽略（不会误杀所有无 id 事件）
        const emptyKey = buildRecordIndex([recSupersede('s4', '', 9)]);
        assert.equal(isVisible(userA, emptyKey), true);
    },

    testContextViewRecordsEdit() {
        const edited = buildRecordIndex([
            recEdit('ed1', 2, '很早的编辑', 100),
            recEdit('ed2', 2, '最后到达的编辑', 200),
        ]);
        const user2 = evUser(2);
        assert.deepEqual(applyEdit(user2, edited), [{ type: 'text', text: '最后到达的编辑' }], '同一 seq 取 at 最新的编辑');

        const noEdit = applyEdit(evUser(1), edited);
        assert.deepEqual(noEdit, [{ type: 'text', text: 'u1' }], '无编辑返回原 parts 副本');
        noEdit.push({ type: 'text', text: 'mutated' });
        assert.equal(applyEdit(evUser(1), edited).length, 1, '返回副本，不污染索引');

        const call = evCall(3, 'turn1', 'c1');
        assert.deepEqual(applyEdit(call, edited), [], 'tool_call 没有展示 parts');
    },

    testContextViewRecordsLatestSummary() {
        const index = buildRecordIndex([
            recSummary('sum-a', 1, 5, '五条摘要', 1, 10),
            recSummary('sum-b', 1, 9, '九条摘要', 1, 11),
            recSummary('sum-c', 1, 20, '旧 epoch 摘要', 2, 12),
            recSummary('sum-d', 3, 30, 'fromSeq 不在 epoch 起点', 1, 13),
            recSummary('sum-e', 1, 9, '同 toSeq 更晚到达', 1, 99),
        ]);
        assert.equal(index.summaries.length, 3, '只保留当前 epoch 且 fromSeq<=epochStart 的候选');
        assert.equal(latestSummary(index, 3), null, '没有覆盖到 3 的摘要');
        assert.equal(latestSummary(index, 5)?.id, 'sum-a');
        assert.equal(latestSummary(index, 9)?.id, 'sum-e', '同 toSeq 取 at 更新者');
        assert.equal(latestSummary(index, 100)?.id, 'sum-e', 'toSeq 最大者优先（20 是旧 epoch，30 被过滤）');

        const noSummary = buildRecordIndex([]);
        assert.equal(latestSummary(noSummary, 100), null);
    },

    testContextViewRecordsSummaryGap() {
        const index = buildRecordIndex([recSummary('sum1', 1, 5, '摘要', 1, 10)]);

        // 没有省略（最早选中就是 epoch 起点）
        const noSkip = summaryGap(index, 1);
        assert.equal(noSkip.hasGap, false);
        assert.equal(noSkip.summary, null);
        assert.equal(noSkip.skippedToSeq, 0);

        // 省略 1..5，摘要正好覆盖 → 无缺口
        const covered = summaryGap(index, 6);
        assert.equal(covered.hasGap, false);
        assert.equal(covered.coveredThroughSeq, 5);
        assert.equal(covered.summary?.id, 'sum1');
        assert.equal(covered.uncoveredFromSeq, null);

        // 省略 1..7，摘要只到 5 → 缺口 6..7
        const gap = summaryGap(index, 8);
        assert.equal(gap.hasGap, true);
        assert.equal(gap.coveredThroughSeq, 5);
        assert.equal(gap.uncoveredFromSeq, 6);
        assert.equal(gap.uncoveredToSeq, 7);
        assert.equal(gap.skippedFromSeq, 1);
        assert.equal(gap.skippedToSeq, 7);

        // 完全没有摘要 → 全区间缺口
        const none = summaryGap(buildRecordIndex([]), 4);
        assert.equal(none.hasGap, true);
        assert.equal(none.coveredThroughSeq, 0);
        assert.equal(none.uncoveredFromSeq, 1);
        assert.equal(none.uncoveredToSeq, 3);
    },

    testContextViewRecordsCompositionHappyPath() {
        // 可见性过滤后再切单元：被 epoch 挡掉的旧 call 不会让新组误判"缺结果"
        const events = [
            evUser(1),
            evCall(2, 'turn-old', 'c1'),
            evResult(3, 'turn-old', 'c1'),
            evUser(4),
            evCall(5, 'turn-new', 'c2'),
        ];
        const index = buildRecordIndex([recEpoch('e2', 2, 4, 20)]);
        const visible = applyVisibility(events, index);
        assert.deepEqual(visible.map(e => e.seq), [4, 5]);
        const units = segmentUnits(visible);
        assert.deepEqual(units.map(u => u.kind), ['user', 'tool_group']);
        assert.equal(units[1].complete, false);
        assert.deepEqual(units[1].missingCallIds, ['c2']);
    },
};
