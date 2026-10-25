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
        assert.ok(text.includes('原文过长'));
        assert.ok(text.includes('read_raw id=e:2-2'));
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
        assert.ok(text.includes('更早内容未摘要'));
        assert.ok(text.includes('read_raw id=e:1-1'));
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
        assert.ok(textOf([assistant!]).includes('未完成'));
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
        assert.ok(text.includes('【工具返回:get_weather】'));
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
};
