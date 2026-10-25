// Context v2 只读投影单测：旧 MessageType 形状、可见性/编辑、工具组、边界、冻结。
import assert from 'node:assert/strict';

import { ConversationEvent } from '../src/context/events';
import { createEmptyHead } from '../src/context/head';
import { buildProjection } from '../src/context/projection';
import { ContextSnapshot } from '../src/context/store';

const HEAD = createEmptyHead();

function snapshot(events: ConversationEvent[], records: ContextSnapshot['records'] = []): ContextSnapshot {
    return { head: { ...HEAD }, events, records, version: 1 };
}

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
    return { seq, eventId: `a:${seq}`, at: seq, recvAt: seq, kind: 'assistant', msgId: `a${seq}`, parts: [{ type: 'text', text }] };
}

function systemEvent(seq: number, text: string): ConversationEvent {
    return { seq, eventId: `e:s${seq}`, at: seq, recvAt: seq, kind: 'event', systemName: '事件', eventType: 'group_recall', raw: { id: seq }, parts: [{ type: 'text', text }] };
}

function toolCall(seq: number, callId: string): ConversationEvent {
    return { seq, eventId: `tc:g:${callId}`, at: seq, recvAt: seq, kind: 'tool_call', turnId: 't', groupId: 'g', callId, name: 'f', args: '{}' };
}

function toolResult(seq: number, callId: string): ConversationEvent {
    return { seq, eventId: `tr:g:${callId}`, at: seq, recvAt: seq, kind: 'tool_result', turnId: 't', groupId: 'g', callId, name: 'f', parts: [{ type: 'text', text: `结果${callId}` }] };
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextV2ProjectionBasicShapes() {
        const events = [
            userEvent(1, '你好'),
            systemEvent(2, '有人撤回'),
            assistantEvent(3, '我在'),
            toolCall(4, 'c1'),
            toolResult(5, 'c1'),
        ];
        const projection = buildProjection(snapshot(events));
        assert.equal(projection.length, 5);
        assert.equal(projection[0].role, 'user');
        const user = projection[0] as any;
        assert.equal(user.contentItems[0].userId, 'QQ:1');
        assert.equal(user.contentItems[0].messageId, 'm1');
        const sys = projection[1] as any;
        assert.equal(sys.role, 'user');
        assert.equal(sys.contentItems[0].systemName, '事件');
        assert.equal(sys.contentItems[0].eventType, 'group_recall');
        assert.equal(projection[2].role, 'assistant');
        const calls = projection[3] as any;
        assert.equal(calls.role, 'assistant');
        assert.equal(calls.toolCalls.length, 1);
        assert.equal(calls.toolCalls[0].id, 'c1');
        assert.equal(projection[4].role, 'tool');
        assert.equal((projection[4] as any).toolCallId, 'c1');
        assert.ok(Object.isFrozen(projection));
        assert.ok(Object.isFrozen(projection[0]));
    },

    testContextV2ProjectionEditAndRedact() {
        const events = [userEvent(1, '原始'), userEvent(2, '隐藏'), userEvent(3, '最新')];
        const records = [
            { kind: 'edit' as const, id: 'e1', at: 1, seq: 1, parts: [{ type: 'text' as const, text: '编辑后' }] },
            { kind: 'redact' as const, id: 'r2', at: 2, epoch: 1, fromSeq: 2, toSeq: 2, target: 'user' as const },
        ];
        const projection = buildProjection(snapshot(events, records));
        const text = JSON.stringify(projection);
        assert.ok(text.includes('编辑后'));
        assert.equal(text.includes('隐藏'), false);
        assert.ok(text.includes('最新'));
    },

    testContextV2ProjectionIncompleteToolGroupNoHalfGroup() {
        const events = [userEvent(1, '查'), toolCall(2, 'c1')];
        const projection = buildProjection(snapshot(events));
        const toolCalls = projection.filter(m => (m as any).toolCalls);
        assert.equal(toolCalls.length, 0, '不完整组不得产生 ToolCallsMessage');
        assert.ok(JSON.stringify(projection).includes('调用未完成'));
    },

    testContextV2ProjectionBoundedKeepsNewest() {
        const events = [userEvent(1, 'a'), userEvent(2, 'b'), userEvent(3, '最新消息')];
        const projection = buildProjection(snapshot(events), { maxUnits: 1, maxChars: 200 });
        assert.equal(projection.length, 1);
        assert.ok(JSON.stringify(projection).includes('最新消息'));
    },

    testContextV2ProjectionOrphanResult() {
        const events = [{ seq: 1, eventId: 'tr:orphan', at: 1, recvAt: 1, kind: 'tool_result', turnId: 't', groupId: 'g', callId: 'x', parts: [{ type: 'text', text: '孤儿结果' }] }] as ConversationEvent[];
        const projection = buildProjection(snapshot(events));
        assert.equal(projection.length, 1);
        assert.equal(projection[0].role, 'tool');
        assert.ok(JSON.stringify(projection).includes('孤儿结果'));
    },
};
