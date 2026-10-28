// Context v2 请求编译器单测：选择/最新必留/摘要缺口/工具组/PE/多模态/截断。
import assert from 'node:assert/strict';

import { ConversationEvent, Part } from '../src/context/events';
import { createEmptyHead } from '../src/context/head';
import { ContextSnapshot } from '../src/context/store';
import { compileRequest, CompiledMessage } from '../src/context/view/compile';

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
    formatDateKey: (at: number) => `d${Math.floor(at / 86400)}`,
    formatMessageId: (id: string) => id,
};

export const tests: Record<string, () => void | Promise<void>> = {
    testContextV2CompileSelectsNewestWithinBudget() {
        const events = [userEvent(1, 'one'), assistantEvent(2, 'two'), userEvent(3, 'three')];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 25,
        });
        // 最新单元必留；预算 25 只能再容纳 1 个单元（每单元 10 token）
        assert.equal(result.stats.unitsSelected, 2);
        assert.equal(result.stats.truncated, false);
        assert.equal(result.stats.lastSelectedSeq, 3);
        assert.ok(result.stats.firstSelectedSeq >= 2);
        assert.ok(textOf(result.messages).includes('three'));
    },

    testContextV2CompileNewestAlwaysIncludedWhenBudgetZero() {
        const events = [userEvent(1, 'older'), userEvent(2, '新'.repeat(500))];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 0,
        });
        assert.equal(result.stats.unitsSelected, 1);
        assert.equal(result.stats.truncated, true);
        const text = textOf(result.messages);
        assert.ok(text.includes('新'));
        assert.ok(text.includes('[content-truncated:'));
        assert.ok(text.includes('read_raw id=e:2'));
    },

    testContextV2CompileSummaryAndGapInjected() {
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
            budgetTokens: 10, // 只选最新一个单元
        });
        assert.equal(result.stats.unitsSelected, 1);
        assert.equal(result.stats.summaryInjected, true);
        assert.equal(result.stats.gapInjected, true);
        const text = textOf(result.messages);
        assert.ok(text.includes('更早的摘要内容'));
        assert.ok(text.includes('Earlier events were not summarized'));
        assert.ok(text.includes('read_raw id=e:1'));
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

    testContextV2CompileIncompleteToolGroupNoToolCalls() {
        const events = [userEvent(1, '查天气'), toolCall(2, 't1', 'g1', 'c1')];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
        });
        const assistant = result.messages.find(m => m.role === 'assistant');
        assert.ok(assistant);
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

    testContextV2CompileNoSummaryWhenNothingSkipped() {
        const events = [userEvent(1, 'only')];
        const records = [{
            kind: 'summary' as const,
            id: 'sum:0',
            at: 0,
            epoch: 1,
            fromSeq: 1,
            toSeq: 1,
            text: '不应注入',
        }];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events, records),
            budgetTokens: 1000,
        });
        assert.equal(result.stats.summaryInjected, false);
        assert.equal(textOf(result.messages).includes('不应注入'), false);
    },

    // ---- v5：摘要边界按单元过滤 / 标签分级 / 时间锚点 / stale 回退 / 裁剪统计 ----
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
        assert.equal(result.stats.omittedFromSeq, null);
    },

    testContextV2CompileTagBoundary() {
        const events = [userEvent(1, 'u1', 'm1'), userEvent(2, 'u2', 'm2'), userEvent(3, 'u3', 'm3'),
            userEvent(4, 'u4', 'm4'), userEvent(5, 'u5', 'm5')];
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
            tagBoundaryTokens: 25,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('[msg_id:m5]'));
        assert.ok(text.includes('[msg_id:m4]'));
        assert.equal(text.includes('[msg_id:m3]'), false, '超出标签边界应去掉 msg_id');
        assert.equal(text.includes('[msg_id:m1]'), false);
        assert.equal(result.stats.taggedMessages, 2);
    },

    testContextV2CompileTimeAnchors() {
        const ats = [86390, 86410, 86420, 86430, 86440];
        const events = ats.map((at, i) => ({
            seq: i + 1,
            eventId: `u:${i + 1}`,
            at,
            recvAt: at,
            kind: 'user' as const,
            uid: 'QQ:1',
            msgId: `m${i + 1}`,
            parts: [{ type: 'text' as const, text: `msg${i + 1}` }],
        }));
        const result = compileRequest({
            ...baseOptions,
            snapshot: snapshot(events),
            budgetTokens: 1000,
            tagBoundaryTokens: 10,
        });
        const text = textOf(result.messages);
        assert.ok(text.includes('[time:86390]'), '未标记区首条应显示时间');
        assert.ok(text.includes('[time:86410]'), '跨自然日应显示时间');
        assert.equal(text.includes('[time:86420]'), false, '同日且无间隔不应显示时间');
        assert.equal(text.includes('[time:86430]'), false);
        assert.ok(text.includes('[msg_id:m5]'), '边界内消息仍带 msg_id');
        assert.equal(text.includes('[msg_id:m1]'), false);
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

    testContextV2CompileOmitsUnsummarizedForTrigger() {
        const events = [userEvent(1, 'u1'), assistantEvent(2, 'a2'), userEvent(3, 'u3'), assistantEvent(4, 'a4')];
        const records = [{
            kind: 'summary' as const, id: 'sum:1', at: 10, epoch: 1,
            fromSeq: 1, toSeq: 2, text: '旧摘要', fromAt: 1, toAt: 2,
        }];
        const result = compileRequest({ ...baseOptions, snapshot: snapshot(events, records), budgetTokens: 10 });
        assert.equal(result.stats.unitsSelected, 1);
        assert.equal(result.stats.summaryInjected, true);
        assert.equal(result.stats.gapInjected, true, '摘要与窗口之间被预算裁掉未摘要区，应显式提示');
        assert.equal(result.stats.omittedFromSeq, 3);
        assert.equal(result.stats.omittedToSeq, 3);
    },
};
