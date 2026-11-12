// Context v2 请求编译器单测：全量渲染/前缀稳定性（R1/R2/R3）/摘要缺口/工具组结算/PE/多模态/固定上限截断。
import assert from 'node:assert/strict';

import { ConversationEvent, Part } from '../src/context/events';
import { createEmptyHead } from '../src/context/head';
import { ContextSnapshot } from '../src/context/store';
import { compileRequest, CompiledMessage } from '../src/context/view/compile';
import { sliceAtAnchor } from '../src/context/view/units';
import { truncateToTokenBudget } from '../src/utils/token_budget';
import { estimateEventTokens as estimateEventTokensReal, estimateTextTokens as estimateTextTokensReal } from '../src/utils/token_estimate';

const HEAD = createEmptyHead();
const estimateTextTokens = (text: string): number => String(text || '').length;
const estimateEventTokens = (): number => 10;

function userEvent(seq: number, text: string, msgId = `m${seq}`): ConversationEvent {
    return {
        seq,
        eventId: `u:${msgId}`,
        at: seq,
        recvAt: seq,
        kind: 'user',
        uid: 'QQ:1',
        msgId,
        parts: [{ type: 'text', text }],
    };
}

function assistantEvent(seq: number, text: string): ConversationEvent {
    return {
        seq,
        eventId: `a:${seq}`,
        at: seq,
        recvAt: seq,
        kind: 'assistant',
        msgId: `a${seq}`,
        parts: [{ type: 'text', text }],
    };
}

function toolCall(seq: number, turnId: string, groupId: string, callId: string, name = 'get_weather'): ConversationEvent {
    return {
        seq,
        eventId: `tc:${groupId}:${callId}`,
        at: seq,
        recvAt: seq,
        kind: 'tool_call',
        turnId,
        groupId,
        callId,
        name,
        args: '{"city":"x"}',
    };
}

function toolResult(seq: number, turnId: string, groupId: string, callId: string, name = 'get_weather'): ConversationEvent {
    return {
        seq,
        eventId: `tr:${groupId}:${callId}`,
        at: seq,
        recvAt: seq,
        kind: 'tool_result',
        turnId,
        groupId,
        callId,
        name,
        parts: [{ type: 'text', text: '晴，25度' }],
    };
}

function snapshot(events: ConversationEvent[], records: ContextSnapshot['records'] = []): ContextSnapshot {
    return { head: { ...HEAD }, events, records, version: 1 };
}

function textOf(messages: CompiledMessage[]): string {
    return messages.map(m => (typeof m.content === 'string' ? m.content : m.content.map(b => (b.type === 'text' ? b.text : '[image]')).join(''))).join('\n');
}

const baseOptions = {
    estimateTextTokens,
    estimateEventTokens,
    resolveUserName: (uid: string) => uid,
    formatTime: (at: number) => String(at),
};

export const tests: Record<string, () => void | Promise<void>> = {
    /**
     * #163 REQ-D2-10：全量渲染 —— 预算**不再**决定装多少单元。
     *
     * 旧断言（预算 25 只装 2 个单元）正是要消灭的行为：同一段历史在预算抖动时从中间被丢，
     * 已发送前缀的字节随之改写。现在预算只影响 `needsArchive`（观测/兜底）。
     */
    testContextV2CompileRendersAllUnitsRegardlessOfBudget() {
        const events = [userEvent(1, 'one'), assistantEvent(2, 'two'), userEvent(3, 'three')];
        const tight = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 25,
        });
        assert.equal(tight.stats.unitsTotal, 3);
        assert.equal(tight.stats.unitsRendered, 3, '全量渲染：预算不足也渲染全部单元');
        assert.equal(tight.stats.lastSelectedSeq, 3);
        assert.equal(tight.stats.firstSelectedSeq, 1);
        assert.equal(tight.stats.needsArchive, true, '渲染总量超预算 ⇒ 仅观测 needsArchive');
        const text = textOf(tight.messages);
        for (const word of ['one', 'two', 'three']) assert.ok(text.includes(word), `预算紧张也必须渲染 ${word}`);

        const loose = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 100000,
        });
        assert.equal(loose.stats.needsArchive, false, '预算充足不应报 needsArchive');
        assert.deepEqual(textOf(loose.messages), textOf(tight.messages), 'R2：预算变化不得改变渲染字节');
    },

    /**
     * #163 REQ-D2-07：预算为 0 时不再截断最新单元（截断改为固定常量驱动）。
     *
     * `HISTORY_EVENT_MAX_TOKENS = 8192`，500 个汉字 ≈ 500 token，远未超限 ⇒ 不截断。
     * 注意两条连续 user 无 anchor ⇒ 合并为 1 个单元（`unitsRendered = 1`）。
     */
    testContextV2CompileNoBudgetDrivenTruncation() {
        const events = [userEvent(1, 'older'), userEvent(2, '新'.repeat(500))];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 0,
        });
        assert.equal(result.stats.unitsTotal, 1, '相邻 user 合并为一个单元');
        assert.equal(result.stats.unitsRendered, 1, '预算 0 也渲染该单元');
        assert.equal(result.stats.needsArchive, true);
        const text = textOf(result.messages);
        assert.ok(text.includes('新'.repeat(500)), '未超固定上限 ⇒ 不截断');
        assert.equal(text.includes('[content-truncated:'), false);
    },

    /**
     * 摘要块注入 + 边界紧邻 ⇒ 无缺口提示（全量渲染后 2/3 都可见，摘要与窗口直接相接）。
     */
    testContextV2CompileSummaryInjectedNoGapWhenAdjacent() {
        const events = [userEvent(1, 'a'), assistantEvent(2, 'b'), userEvent(3, 'c')];
        const records = [{
            kind: 'summary' as const,
            id: 'sum:1',
            at: 10,
            epoch: 1,
            fromSeq: 1,
            toSeq: 1,
            text: '更早的摘要内容',
        }];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events, records),
            budgetTokens: 10,
        });
        assert.equal(result.stats.unitsRendered, 2, '被摘要覆盖的单元不渲染，其余全量渲染');
        assert.equal(result.stats.summaryInjected, true);
        assert.equal(result.stats.gapInjected, false, '摘要边界与首个可见单元紧邻 ⇒ 无缺口');
        const text = textOf(result.messages);
        assert.ok(text.includes('更早的摘要内容'));
        assert.equal(text.includes('Earlier events were not summarized'), false);
    },

    testContextV2CompileToolGroupNative() {
        const events = [
            userEvent(1, '查天气'),
            toolCall(2, 't1', 'g1', 'c1'),
            toolResult(3, 't1', 'g1', 'c1'),
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        const assistant = result.messages.find(m => m.role === 'assistant' && m.tool_calls);
        assert.ok(assistant);
        assert.equal(assistant!.tool_calls!.length, 1);
        assert.equal(assistant!.tool_calls![0].id, 'c1');
        const tool = result.messages.find(m => m.role === 'tool');
        assert.ok(tool);
        assert.equal(tool!.tool_call_id, 'c1');
        assert.ok(textOf([tool!]).includes('晴，25度'));
    },

    /**
     * #163 REQ-D2-09：**未结算的工具组本轮不渲染**。
     *
     * 旧断言（渲染"Unfinished tool calls"文本）正是 R1 风险源：结果晚到后该文本会被改写成
     * 真实 tool 消息，已发送区字节被改写。现在等结算（出现更晚的 user/assistant 事件）后再渲染。
     */
    testContextV2CompileUnsettledToolGroupNotRendered() {
        const events = [userEvent(1, '查天气'), toolCall(2, 't1', 'g1', 'c1')];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        assert.equal(result.stats.unitsTotal, 2, '单元仍然存在（供归档水位用）');
        assert.equal(result.stats.unitsRendered, 1, '未结算组不参与渲染');
        const text = textOf(result.messages);
        assert.ok(text.includes('查天气'));
        assert.equal(text.includes('Unfinished tool calls'), false, '未结算组不得渲染"调用未完成"文本');
        assert.equal(result.messages.some(m => m.role === 'tool'), false);
        assert.equal(result.messages.some(m => m.role === 'assistant'), false);
    },

    /**
     * #163 REQ-D2-09 反面：**已结算**的不完整组照常渲染（结果永久缺失，形态不再变化）。
     * 结算判据 = 该 turn 之后已出现更晚的 user/assistant 事件。
     */
    testContextV2CompileSettledIncompleteToolGroupRendersText() {
        const events = [
            userEvent(1, '查天气'),
            toolCall(2, 't1', 'g1', 'c1'),
            assistantEvent(3, '算了，不查了'),
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        assert.equal(result.stats.unitsRendered, 3, '已结算组参与渲染');
        const assistant = result.messages.find(m => m.role === 'assistant' && m.content !== undefined && String(m.content).includes('Unfinished'));
        assert.ok(assistant, '已结算的不完整组渲染为"调用未完成"文本');
        assert.equal(assistant!.tool_calls, undefined, '不完整组不得产生 tool_calls');
        assert.ok(textOf([assistant!]).includes('Unfinished tool calls (no result): get_weather'));
    },

    testContextV2CompilePromptEngineeringMode() {
        const events = [
            userEvent(1, '查天气'),
            toolCall(2, 't1', 'g1', 'c1'),
            toolResult(3, 't1', 'g1', 'c1'),
        ];
        const result = compileRequest({
            ...baseOptions,
            mode: 'prompt-engineering',
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('```function'));
        assert.ok(text.includes('[tool_result:get_weather]'));
        assert.ok(text.includes('[/tool_result]'));
        assert.equal(result.messages.some(m => m.role === 'tool'), false);
    },

    testContextV2CompileEditAndRedact() {
        const events = [userEvent(1, '原始'), userEvent(2, '应被隐藏'), userEvent(3, '最新')];
        const records = [
            { kind: 'edit' as const, id: 'edit:1', at: 1, seq: 1, parts: [{ type: 'text' as const, text: '编辑后' }] as Part[] },
            { kind: 'redact' as const, id: 'redact:2', at: 2, epoch: 1, fromSeq: 2, toSeq: 2, target: 'user' as const },
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events, records),
            budgetTokens: 1000,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('编辑后'));
        assert.equal(text.includes('应被隐藏'), false);
        assert.ok(text.includes('最新'));
    },

    testContextV2CompileVisionAndTextOnly() {
        const imagePart: Part = { type: 'image', ref: 'h123', desc: '猫' };
        const event: ConversationEvent = {
            seq: 1,
            eventId: 'u:img',
            at: 1,
            recvAt: 1,
            kind: 'user',
            uid: 'QQ:1',
            msgId: 'img',
            parts: [imagePart],
        };
        const vision = compileRequest({
            ...baseOptions,
            snapshot: snapshot([event]),
            budgetTokens: 1000,
            caps: { vision: true },
            resolve: { imageUrl: () => 'https://example.com/cat.png' },
        });
        const userVision = vision.messages.find(m => m.role === 'user')!;
        assert.ok(Array.isArray(userVision.content));
        assert.ok((userVision.content as Array<{ type: string }>).some(b => b.type === 'image_url'));
        assert.ok(textOf([userVision]).includes('[img:h123:猫]'), '多模态也要保留规范 id 标签');

        const textOnly = compileRequest({
            ...baseOptions,
            snapshot: snapshot([event]),
            budgetTokens: 1000,
            caps: { vision: false },
        });
        const userText = textOnly.messages.find(m => m.role === 'user')!;
        assert.equal(typeof userText.content, 'string');
        assert.ok(textOf([userText]).includes('[img:h123:猫]'));
    },

    /**
     * #163 REQ-D2-13：摘要覆盖全部可见单元时，**不得**回退成渲染原文（旧"过滤后为空则回退全量"防御）。
     *
     * 该防御在归档场景下会把已隐藏的原文重新渲染出来 ⇒ 前缀凭空变长，缓存全灭。
     * 新行为：保留摘要、原文不出现；`boundaryDefense` 仅作观测标记。
     */
    testContextV2CompileSummaryCoversAllKeepsSummaryNotOriginals() {
        const events = [userEvent(1, 'only')];
        const records = [{
            kind: 'summary' as const,
            id: 'sum:0',
            at: 0,
            epoch: 1,
            fromSeq: 1,
            toSeq: 1,
            text: '摘要覆盖唯一事件',
        }];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events, records),
            budgetTokens: 1000,
        });
        assert.equal(result.stats.summaryInjected, true, '摘要照常注入');
        assert.equal(result.stats.unitsRendered, 0, '被摘要覆盖的单元一律不渲染');
        assert.equal(result.stats.boundaryDefense, true, '边界防御触发（仅观测）');
        const text = textOf(result.messages);
        assert.ok(text.includes('摘要覆盖唯一事件'));
        assert.equal(text.includes('only'), false, '绝不回退渲染已隐藏的原文');
    },

    // ---- v5：摘要边界按单元过滤 / stale 回退 / #163 D2：无标签 + 全量渲染 ----
    testContextV2CompileSummaryBoundaryFiltersSummarizedEvents() {
        const events = [
            userEvent(1, 'u1'), assistantEvent(2, 'a2'), userEvent(3, 'u3'),
            assistantEvent(4, 'a4'), userEvent(5, 'u5'), assistantEvent(6, 'a6'),
        ];
        const records = [{
            kind: 'summary' as const, id: 'sum:1', at: 10, epoch: 1,
            fromSeq: 1, toSeq: 4, text: '旧摘要', fromAt: 1, toAt: 4,
        }];
        const result = compileRequest({ ...baseOptions, snapshot: snapshot(events, records), budgetTokens: 1000 });
        const text = textOf(result.messages);
        for (const hidden of ['u1', 'a2', 'u3', 'a4']) {
            assert.equal(text.includes(hidden), false, `已摘要事件 ${hidden} 不应再以原文出现`);
        }
        assert.ok(text.includes('旧摘要'));
        assert.ok(text.includes('u5') && text.includes('a6'));
        assert.equal(result.stats.summaryBoundarySeq, 4);
        assert.equal(result.stats.summaryInjected, true);
        assert.equal(result.stats.gapInjected, false, '摘要与窗口紧邻，不应报缺口');
        assert.equal(result.stats.needsArchive, false, '预算充足不应报 needsArchive');
    },

    /**
     * #163 REQ-D2-01/02：历史**一律**不带 `[msg_id]` / `[time]`。
     *
     * 这两者都是"按窗口位置开合"的标签 ⇒ 同一段历史的字节随预算/轮次漂移。删掉后，
     * 模型定位历史走 `grep_raw`/`read_raw`（D5），时间走注入块 + `get_time`（D4）。
     * 附带验证 `[from]` 仍在（这是身份信息，写时冻结）。
     */
    testContextV2CompileHistoryHasNoMsgIdOrTimeTags() {
        const ats = [86390, 86410, 86420, 86430, 86440];
        const events = ats.map((at, i): ConversationEvent => ({
            seq: i + 1,
            eventId: `u:${i + 1}`,
            at,
            recvAt: at,
            kind: 'user',
            uid: 'QQ:1',
            msgId: `m${i + 1}`,
            parts: [{ type: 'text', text: `msg${i + 1}` }],
        }));
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        const text = textOf(result.messages);
        assert.equal(text.includes('[msg_id:'), false, '历史不得渲染 [msg_id]');
        assert.equal(text.includes('[time:'), false, '历史不得渲染 [time]');
        assert.ok(text.includes('[from:QQ:1]'), '[from] 保留（写时冻结的身份）');
        for (let i = 1; i <= 5; i++) assert.ok(text.includes(`msg${i}`), `第 ${i} 条必须渲染（全量）`);
    },

    /**
     * #163 REQ-D2-01 例外：**`renderSystemEvent` 的 `[time]` 保留**（`event.at` 是写时冻结值）。
     * 这是历史层唯一保留 `[time]` 的位置（wake / 非即时轮次需要"现在"，REQ-D4-06）。
     */
    testContextV2CompileSystemEventKeepsFrozenTime() {
        const events: ConversationEvent[] = [
            userEvent(1, '在吗'),
            {
                seq: 2,
                eventId: 'e:1',
                at: 1_700_000_000,
                recvAt: 1_700_000_000,
                kind: 'event',
                systemName: 'wake',
                parts: [{ type: 'text', text: '定时器唤醒' }],
            },
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('[time:1700000000]'), 'system 事件的 [time] 必须保留');
        assert.ok(text.includes('[system:wake]'));
        assert.ok(text.includes('定时器唤醒'));
    },

    testContextV2CompileStaleSummaryFallsBack() {
        const events = [userEvent(1, '原始一'), assistantEvent(2, '原始二'), userEvent(3, '最新')];
        const records = [
            { kind: 'summary' as const, id: 'sum:1', at: 10, epoch: 1, fromSeq: 1, toSeq: 2, text: '旧摘要' },
            { kind: 'edit' as const, id: 'edit:1', at: 11, seq: 1, parts: [{ type: 'text' as const, text: '编辑后' }] },
        ];
        const result = compileRequest({ ...baseOptions, snapshot: snapshot(events, records), budgetTokens: 1000 });
        const text = textOf(result.messages);
        assert.equal(result.stats.summaryStale, true, '摘要区间与 edit/redact 相交应为 stale');
        assert.ok(text.includes('编辑后'), 'stale 时回退旧行为：原文优先（编辑后）');
        assert.ok(text.includes('原始二'));
        assert.equal(result.stats.summaryBoundarySeq, 0);
    },

    /**
     * #163 REQ-D2-10/14：摘要放不下时**不再让位**（让位 = 从历史中间丢单元 = 改写已发送前缀），
     * 只把 `needsArchive` 标起来。gap 是否注入仍取决于边界与首个可见单元之间是否真有空洞。
     */
    testContextV2CompileNoYieldWhenSummaryExceedsBudget() {
        const events = [userEvent(1, 'u1'), assistantEvent(2, 'a2'), userEvent(3, 'u3'), assistantEvent(4, 'a4')];
        const records = [{
            kind: 'summary' as const, id: 'sum:1', at: 10, epoch: 1,
            fromSeq: 1, toSeq: 2, text: '旧摘要', fromAt: 1, toAt: 2,
        }];
        const result = compileRequest({ ...baseOptions, snapshot: snapshot(events, records), budgetTokens: 10 });
        assert.equal(result.stats.unitsRendered, 2, '摘要不让位：后两个单元仍全部渲染');
        assert.equal(result.stats.summaryInjected, true, '摘要本身不能被静默丢弃');
        assert.equal(result.stats.needsArchive, true, '超预算只观测，不裁剪');
        const text = textOf(result.messages);
        assert.ok(text.includes('u3') && text.includes('a4'));
        assert.equal(text.includes('u1'), false, '摘要已覆盖 u1/a2');
    },

    testTokenBudgetTruncateHeadOnly() {
        const text = 'x'.repeat(100);
        const slice = truncateToTokenBudget(text, 20, estimateTextTokens);
        assert.equal(slice.truncated, true);
        assert.equal(slice.text.length, 20, 'head-only 应保留前 20 token');
        assert.equal(slice.totalTokens, 100);
        assert.equal(slice.shownTokens, 20);
        const off = truncateToTokenBudget(text, 0, estimateTextTokens);
        assert.equal(off.truncated, false, '0=不截断');
        assert.equal(off.text, text);
    },

    testContextV2CompileCapsToolResultByTokens() {
        const events: ConversationEvent[] = [
            toolCall(1, 't1', 'g1', 'c1'),
            {
                ...toolResult(2, 't1', 'g1', 'c1'),
                parts: [{ type: 'text', text: 'x'.repeat(100) }],
            },
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
            toolResultMaxTokens: 20,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('[tool-output-truncated:'), '超限工具结果应带 english 截断标记');
        assert.ok(text.includes('first 20 shown'), '标记应带展示 token 数');
        assert.ok(text.includes('read_raw id=e:2'), '标记应带事件地址供分页回读');
        assert.ok(!text.includes('x'.repeat(30)), '被截掉的尾部不应进入请求');
        assert.equal(result.stats.needsArchive, false, '小工具结果不会让整体超预算');
    },

    testContextV2CompileToolResultCapOffByDefault() {
        const events: ConversationEvent[] = [
            toolCall(1, 't1', 'g1', 'c1'),
            {
                ...toolResult(2, 't1', 'g1', 'c1'),
                parts: [{ type: 'text', text: 'x'.repeat(100) }],
            },
        ];
        const result = compileRequest({ ...baseOptions, snapshot: snapshot(events), budgetTokens: 1000 });
        const text = textOf(result.messages);
        assert.ok(!text.includes('[tool-output-truncated:'), '未配置上限时不截断');
        assert.ok(text.includes('x'.repeat(100)), '原文完整展示');
    },

    testContextV2CompileToolResultCapKeepsImages() {
        const events: ConversationEvent[] = [
            toolCall(1, 't1', 'g1', 'c1'),
            {
                ...toolResult(2, 't1', 'g1', 'c1'),
                parts: [
                    { type: 'text', text: 'y'.repeat(100) },
                    { type: 'image', ref: 'img_keep' },
                ],
            },
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
            toolResultMaxTokens: 20,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('img_keep'), '图片等非文本块应保留（不被截断）');
        assert.ok(text.includes('[tool-output-truncated:'), '文本仍按上限截断');
    },

    testContextV2CompileToolResultCapEstimatorAligned() {
        // 若估算不按上限截断：1000 token 的最新工具结果在 30 预算下会被 compile 兜底截断，
        // 而不是显示"截断后的头部 + 工具截断标记"。
        const events: ConversationEvent[] = [
            toolCall(1, 't1', 'g1', 'c1'),
            {
                ...toolResult(2, 't1', 'g1', 'c1'),
                parts: [{ type: 'text', text: 'z'.repeat(1000) }],
            },
        ];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 30,
            toolResultMaxTokens: 20,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('[tool-output-truncated:'), '应显示工具截断标记而不是整条丢弃/兜底截断');
        assert.equal(text.length < 1000, true, '展示的是截断后的头部（不再是整条 1000 字符）');
    },

    /**
     * #163 REQ-D2-07：单事件超固定上限（`HISTORY_EVENT_MAX_TOKENS`）时截断并带 `read_raw` 指针。
     *
     * 与预算**无关**：`budgetTokens` 给极大值也照样截断 —— 否则同一事件在预算宽裕的轮次
     * 渲染全文、紧张轮次渲染截断版，已发送区字节被改写（R1 破裂）。
     */
    testContextV2CompileCapsEventByFixedConstant() {
        // 4 条连续 user 会被 segmentUnits 合并成 1 个 user 单元（25600 字符 ≈ 6400 token，
        // 未超 8192 ⇒ 不截断）；用 40000 字符（≈10000 token > 8192）验证截断。
        const events = [userEvent(1, '喵'.repeat(40000))];
        const result = compileRequest({
            ...baseOptions,
            estimateTextTokens: estimateTextTokensReal,
            estimateEventTokens: (event) => estimateEventTokensReal(event),
            snapshot: snapshot(events),
            budgetTokens: 10_000_000,
        });
        const text = textOf(result.messages);
        assert.ok(text.length < 40000, `超固定上限应截断（实际 ${text.length} 字符）`);
        assert.ok(text.includes('read_raw id=e:1'), '截断必须带 read_raw 回查指针');
        assert.equal(result.stats.needsArchive, false, '固定上限截断与预算无关');
    },

    /**
     * #163 REQ-D2-07 反面：未超固定上限的事件即使**预算极小**也不截断。
     */
    testContextV2CompileDoesNotTruncateUnderFixedCap() {
        const events = [userEvent(1, '喵'.repeat(4000))];
        const result = compileRequest({
            ...baseOptions,
            estimateTextTokens: estimateTextTokensReal,
            estimateEventTokens: (event) => estimateEventTokensReal(event),
            snapshot: snapshot(events),
            budgetTokens: 10,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('喵'.repeat(4000)), '未超固定上限 ⇒ 一字不删');
        assert.equal(text.includes('read_raw'), false);
        assert.equal(result.stats.needsArchive, true, '预算不足只观测');
    },

    testContextV2CompileHidesArchivedWithoutSummary() {
        const events = [userEvent(1, 'one'), assistantEvent(2, 'two'), userEvent(3, 'three'), assistantEvent(4, 'four')];
        const archivedSnapshot: ContextSnapshot = {
            ...snapshot(events),
            head: { ...HEAD, archivedThrough: 2, nextSeq: 5 },
        };
        const result = compileRequest({ ...baseOptions, snapshot: archivedSnapshot, budgetTokens: 1000 });
        const text = textOf(result.messages);
        assert.ok(!text.includes('one') && !text.includes('two'), '归档块（即使没有摘要）也不得以原文出现');
        assert.ok(text.includes('three') && text.includes('four'), '未归档内容照常可见');
        assert.equal(result.stats.summaryInjected, false);
        assert.equal(result.stats.gapInjected, true, '无摘要归档块必须有缺口提示，不能静默');
        assert.ok(text.includes('read_raw'), '缺口提示带 read_raw 回查指针');
    },

    testContextV2CompileArchivedBeyondSummaryKeepsCoverageGap() {
        const events = [userEvent(1, 'one'), assistantEvent(2, 'two'), userEvent(3, 'three'), assistantEvent(4, 'four'), userEvent(5, 'five')];
        const records = [{
            kind: 'summary' as const,
            id: 'sum:1',
            at: 10,
            epoch: 1,
            fromSeq: 1,
            toSeq: 1,
            text: '摘要A',
        }];
        const archivedSnapshot: ContextSnapshot = {
            ...snapshot(events, records),
            head: { ...HEAD, summarizedThrough: 1, archivedThrough: 3, nextSeq: 6 },
        };
        const result = compileRequest({ ...baseOptions, snapshot: archivedSnapshot, budgetTokens: 1000 });
        const text = textOf(result.messages);
        assert.ok(text.includes('摘要A'), '摘要仍注入');
        assert.ok(!text.includes('two') && !text.includes('three'), '归档但未总结的区间也不以原文出现');
        assert.ok(text.includes('four') && text.includes('five'));
        assert.equal(result.stats.summaryBoundarySeq, 1);
        assert.equal(result.stats.gapInjected, true, '摘要边界与归档边界之间的未总结区间必须有缺口提示');
    },

    // ---- #163 D2 新增：前缀稳定性核心行为 ----

    /**
     * #163 R1（严格前缀扩展）：追加一条消息后，上一轮的全部消息**逐字节不变**。
     *
     * 这是本 PR 的存在理由。用 `anchorSeq` 告知"已发送到哪"，`segmentUnits` 不跨 anchor 合并，
     * 渲染也不带任何随轮次变化的成分 ⇒ 前缀恒等。
     */
    testContextV2CompileStrictPrefixExtension() {
        const round1 = [userEvent(1, '第一条'), assistantEvent(2, '第二条'), userEvent(3, '第三条')];
        const first = compileRequest({
            ...baseOptions,
            snapshot: snapshot(round1),
            budgetTokens: 100_000,
        });
        const anchor = first.stats.lastSelectedSeq;
        assert.equal(anchor, 3);

        const round2 = [...round1, userEvent(4, '第四条')];
        const second = compileRequest({
            ...baseOptions,
            snapshot: snapshot(round2),
            budgetTokens: 100_000,
            anchorSeq: anchor,
        });
        assert.ok(second.messages.length > first.messages.length, '新消息应追加');
        for (let i = 0; i < first.messages.length; i++) {
            assert.deepEqual(second.messages[i], first.messages[i], `第 ${i} 条已发送消息必须逐字节不变`);
        }
        assert.ok(textOf([second.messages[second.messages.length - 1]]).includes('第四条'));
    },

    /**
     * #163 R2（幂等重编译）：同一快照编译两次，字节完全一致。
     */
    testContextV2CompileIdempotent() {
        const events = [userEvent(1, '一'), assistantEvent(2, '二'), userEvent(3, '三')];
        const a = compileRequest({ ...baseOptions, snapshot: snapshot(events), budgetTokens: 1000 });
        const b = compileRequest({ ...baseOptions, snapshot: snapshot(events), budgetTokens: 1000 });
        assert.deepEqual(a.messages, b.messages, 'R2：同快照两次编译必须字节一致');
        assert.deepEqual(a.stats, b.stats);
    },

    /**
     * #163 REQ-D2-12：**跨 anchor 的相邻 user 不合并**。
     *
     * 若合并，下一轮新增一条 user 消息会让已发送的那条 user 消息多出一段文本（字节变了）。
     * 两条 user 在 seq 上连续（模拟"上轮已发第 1 条，本轮又收第 2 条且无 assistant 回复"）。
     */
    testContextV2CompileDoesNotMergeUsersAcrossAnchor() {
        const events = [userEvent(1, '第一句'), userEvent(2, '第二句')];
        const noAnchor = compileRequest({ ...baseOptions, snapshot: snapshot(events), budgetTokens: 1000 });
        assert.equal(noAnchor.messages.length, 1, '无 anchor 时相邻 user 合并（旧行为）');

        const anchored = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
            anchorSeq: 1,
        });
        assert.equal(anchored.messages.length, 2, '跨 anchor 不得合并');
        assert.ok(textOf([anchored.messages[0]]).includes('第一句'));
        assert.ok(textOf([anchored.messages[1]]).includes('第二句'));
    },

    /**
     * #163 REQ-D2-04/05：`[from]` 读**冻结**的 `fromName`，改名不影响已发送字节；
     * 旧数据没有 `fromName` 时回落 `resolveUserName`。
     */
    testContextV2CompileFromNameFrozen() {
        const frozen: ConversationEvent = { ...userEvent(1, '你好'), fromName: '旧名字' } as ConversationEvent;
        const result = compileRequest({
            ...baseOptions,
            // 活名已改成"新名字"：冻结字段优先 ⇒ 渲染必须仍是"旧名字"
            resolveUserName: () => '新名字(1)',
            snapshot: snapshot([frozen]),
            budgetTokens: 1000,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('[from:旧名字(1)]'), '必须渲染写入时冻结的名字');
        assert.equal(text.includes('新名字'), false, '改名不得影响已发送历史');

        const legacy = compileRequest({
            ...baseOptions,
            resolveUserName: () => '旧数据活名(1)',
            snapshot: snapshot([userEvent(2, '没有冻结名')]),
            budgetTokens: 1000,
        });
        assert.ok(textOf(legacy.messages).includes('[from:旧数据活名(1)]'), '旧数据回落活名（REQ-D2-05）');
    },

    /**
     * #163 REQ-D2-16 冻结守卫：已发送前缀被改写时，用快照覆盖回去并记 `prefixDrift`。
     *
     * 构造真实的违约场景（旧数据无 `fromName` + 活名变化）：不启用守卫时前缀会变；
     * 启用守卫后必须逐字节等于快照，且 `stats.prefixDrift` 给出首个差异下标。
     */
    testContextV2CompilePrefixDriftGuardFreezesSentPrefix() {
        const events = [userEvent(1, '历史一'), assistantEvent(2, '历史二')];
        const liveName = { value: '甲(1)' };
        const opts = {
            ...baseOptions,
            resolveUserName: () => liveName.value,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        };
        const first = compileRequest(opts);
        const snapshotOfFirst = {
            messages: first.messages.map(m => JSON.stringify(m)),
            throughSeq: first.stats.lastSelectedSeq,
        };

        // 改名（旧数据没有 fromName ⇒ 渲染读活名）⇒ 前缀本会漂移
        liveName.value = '乙(1)';
        const changed = compileRequest(opts);
        assert.notDeepEqual(changed.messages[0], first.messages[0], '前置条件：不守卫时确实会漂移');
        assert.equal(changed.stats.prefixDrift, undefined, '不传快照 ⇒ 不启用守卫');

        const guarded = compileRequest({ ...opts, prefixSnapshot: snapshotOfFirst });
        assert.equal(guarded.stats.prefixDrift, 0, '守卫应捕获首个差异下标');
        assert.deepEqual(
            guarded.messages.slice(0, first.messages.length),
            first.messages,
            '守卫必须把已发送前缀还原成快照字节（缓存不作废）',
        );
    },

    /**
     * #163 REQ-D2-13：可见性边界过滤后为空时**不回退全量**（脏数据下宁可空历史）。
     *
     * 旧防御"过滤后为空则渲染全部"会把已归档内容重现出来 ⇒ 前缀直接崩掉。
     */
    testContextV2CompileBoundaryDefenseDoesNotRestoreAll() {
        const events = [userEvent(1, 'one'), assistantEvent(2, 'two')];
        const dirty: ContextSnapshot = {
            ...snapshot(events),
            // 脏数据：archivedThrough 越过最新事件（normalizeHead 正常会夹断，此处直接构造）
            head: { ...HEAD, archivedThrough: 99, nextSeq: 100 },
        };
        const result = compileRequest({ ...baseOptions, snapshot: dirty, budgetTokens: 1000 });
        assert.equal(result.stats.boundaryDefense, true, '应标记边界防御触发');
        const text = textOf(result.messages);
        assert.equal(text.includes('one'), false, '绝不能把已归档内容重现出来');
        assert.equal(text.includes('two'), false);
    },

    /**
     * #163 REQ-D6-05/09 / d456 T15-7：`[quote_of:<msgId>]` 是**事件字段直出**。
     *
     * 三条必须锁死：
     * ① 引用事件渲染带 `[quote_of:]`，不随任何 msg_id 展示开关变化（它不在 D2 的删除清单里）；
     * ② 它排在 `[from:...]` **之后**，且与正文之间无分隔符（前缀字节稳定，追加安全）；
     * ③ 非引用事件绝不出现该标签（误加会让所有历史字节变化 ⇒ 全量缓存失效）。
     */
    testContextV2CompileQuoteOfDirectEmit() {
        // 引用事件：正文已由 PR-07 展开进 parts，渲染层只补语义标签
        const quoted: ConversationEvent = {
            ...userEvent(1, '我引用一下'),
            quoteOf: 'quoted-msg-id',
        } as ConversationEvent;
        const plain = userEvent(3, '普通消息');
        // 中间插一条 assistant：相邻 user 会被 `segmentUnits` 合并成一个单元（一个 message），
        // 那样就取不到独立的两条消息来对比了。
        const middle = assistantEvent(2, '好的');
        const displayOptions = { ...baseOptions, resolveUserName: (uid: string) => `${uid.replace(/^.+:/, '')}号(${uid.replace(/^.+:/, '')})` };
        const result = compileRequest({
            ...displayOptions,
            snapshot: snapshot([quoted, middle, plain]),
            budgetTokens: 1000,
        });
        assert.equal(result.messages.length, 3, '三个单元应渲染成三条消息');
        const first = typeof result.messages[0].content === 'string' ? result.messages[0].content : textOf([result.messages[0]]);
        assert.ok(first.startsWith('[from:1号(1)]'), `\`[from]\` 必须仍在最前面（先身份后语义），实际：${first}`);
        assert.ok(first.includes('[quote_of:quoted-msg-id]'), `引用事件必须直出 [quote_of:]，实际：${first}`);
        assert.ok(
            first.indexOf('[from:') < first.indexOf('[quote_of:'),
            '`[quote_of:]` 必须在 `[from:]` 之后',
        );
        const second = typeof result.messages[2].content === 'string' ? result.messages[2].content : textOf([result.messages[2]]);
        assert.equal(second.includes('[quote_of:'), false, '非引用事件不得出现 [quote_of:]');

        // 与 msg_id 展示开关彻底解耦：编译入参里已经没有任何 tag/msgId 开关，
        // 因此同一 snapshot 两次编译必须逐字节相同（等价于"开关变化不影响它"）
        const again = compileRequest({ ...displayOptions, snapshot: snapshot([quoted, middle, plain]), budgetTokens: 1 });
        assert.deepEqual(again.messages, result.messages, '预算变化不得改变含引用事件的渲染字节');
    },

    /**
     * #163 REQ-D2-11：`sliceAtAnchor` 用"此前 max(toSeq)"累积判据 —— 工具组的 `toSeq`
     * 可能越过后续单元的 `seq`，逐条判会切错。
     */
    testSliceAtAnchorUsesCumulativeMax() {
        // 单元 A: seq 1..5（工具组晚到，toSeq=5），单元 B: seq 2（seq 更小但在 A 之后成单元）
        const units = [
            { kind: 'tool_group' as const, fromSeq: 1, toSeq: 5, events: [], complete: true, settled: true },
            { kind: 'assistant' as const, fromSeq: 6, toSeq: 6, events: [], complete: true },
            { kind: 'user' as const, fromSeq: 7, toSeq: 7, events: [], complete: true },
        ];
        assert.deepEqual(sliceAtAnchor(units, 5), { frozenCount: 1, boundarySeq: 5 });
        assert.deepEqual(sliceAtAnchor(units, 6), { frozenCount: 2, boundarySeq: 6 });
        assert.deepEqual(sliceAtAnchor(units, 99), { frozenCount: 3, boundarySeq: 7 });
        assert.deepEqual(sliceAtAnchor(units, 0), { frozenCount: 0, boundarySeq: 0 }, '0 = 无冻结区');
    },
};
