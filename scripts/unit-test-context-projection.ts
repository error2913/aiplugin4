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
    return { seq, eventId: `e:s${seq}`, at: seq, recvAt: seq, kind: 'event', systemName: 'group-event', eventType: 'group_recall', raw: { id: seq }, parts: [{ type: 'text', text }] };
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
        assert.equal(sys.contentItems[0].systemName, 'group-event');
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
        assert.ok(JSON.stringify(projection).includes('Tool calls unfinished: f'));
    },

    testContextV2ProjectionBoundedKeepsNewest() {
        const events = [userEvent(1, 'a'), userEvent(2, 'b'), userEvent(3, '最新消息')];
        const projection = buildProjection(snapshot(events), { maxUnits: 1, maxChars: 200 });
        assert.equal(projection.length, 1);
        assert.ok(JSON.stringify(projection).includes('最新消息'));
    },

    /** token 主口径（方案 §11.2 B1）：从最新单元往前按 token 预算选，最新单元必留 */
    testContextV2ProjectionTokenBudget() {
        // 交替 user/assistant，保证每条消息各自成单元；每条 ≈ 102 token（2 CJK + 1 digit + 100 CJK）
        const events: ConversationEvent[] = [];
        for (let i = 1; i <= 3; i++) {
            events.push(userEvent(i * 2 - 1, '用户' + i + '字'.repeat(100)));
            events.push(assistantEvent(i * 2, '助手' + i + '字'.repeat(100)));
        }
        const projection = buildProjection(snapshot(events), { maxTokens: 250 });
        const text = JSON.stringify(projection);
        assert.ok(text.includes('助手3'), '最新单元必留');
        assert.ok(text.includes('用户3'), '最新两条应能装进 250 token');
        assert.ok(!text.includes('助手2'), '更旧单元超出 token 预算应被裁掉');
        assert.ok(!text.includes('用户1'), '最旧单元不应包含');

        // maxTokens=0：只保留最新单元（0 = 不额外保留，不是「无限」）
        const onlyLatest = buildProjection(snapshot(events), { maxTokens: 0 });
        assert.equal(onlyLatest.length, 1, 'maxTokens=0 应只保留最新单元');
        assert.ok(JSON.stringify(onlyLatest).includes('助手3'));

        // 最新单元自身超预算也必留
        const huge = [{ seq: 1, eventId: 'u:huge', at: 1, recvAt: 1, kind: 'user' as const, uid: 'QQ:1', msgId: 'huge', parts: [{ type: 'text' as const, text: '巨'.repeat(2000) }] }];
        const hugeProjection = buildProjection(snapshot(huge), { maxTokens: 10 });
        assert.equal(hugeProjection.length, 1, '最新单元必留');
    },

    /** maxChars 作为旧调用兼容上限仍与 token 同时生效（先到先停） */
    testContextV2ProjectionLegacyMaxCharsStillApplies() {
        const events: ConversationEvent[] = [
            userEvent(1, '旧'.repeat(100)),
            assistantEvent(2, '中'.repeat(100)),
            userEvent(3, '新'.repeat(100)),
        ];
        const projection = buildProjection(snapshot(events), { maxChars: 150 });
        assert.equal(projection.length, 1, '字符上限应继续生效（最新 100 字 + 次新 100 字超过 150）');
        assert.ok(JSON.stringify(projection).includes('新'));
    },

    testContextV2ProjectionOrphanResult() {
        const events = [{ seq: 1, eventId: 'tr:orphan', at: 1, recvAt: 1, kind: 'tool_result', turnId: 't', groupId: 'g', callId: 'x', parts: [{ type: 'text', text: '孤儿结果' }] }] as ConversationEvent[];
        const projection = buildProjection(snapshot(events));
        assert.equal(projection.length, 1);
        assert.equal(projection[0].role, 'tool');
        assert.ok(JSON.stringify(projection).includes('孤儿结果'));
    },
};
