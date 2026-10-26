// Context v2 迁移器单测：旧 messages → 事件/记录，原文不丢、seq/eventId 确定性。
import assert from 'node:assert/strict';

import { buildLegacyEvents, LegacyContextLike } from '../src/context/migrate/v1';

function legacyContext(): LegacyContextLike {
    return {
        archiveSeq: 2,
        rawSeq: 3,
        settledSeq: 1,
        messages: [
            {
                role: 'user',
                contentItems: [
                    {
                        userId: 'QQ:1',
                        messageId: 'm1',
                        time: 10,
                        text: '合并摘要（显示）',
                        rawItems: [
                            { userId: 'QQ:1', messageId: 'm1a', time: 10, text: '原文A' },
                            { userId: 'QQ:2', messageId: 'm1b', time: 11, text: '原文B' },
                        ],
                    },
                    { userId: 'QQ:1', messageId: 'm2', time: 12, text: '普通消息' },
                ],
            },
            { role: 'user', contentItems: [{ systemName: 'group-event', eventType: 'group_recall', raw: { id: 1 }, time: 13, text: '有人撤回' }] },
            {
                role: 'assistant',
                contentItems: [{ text: '我来看看', time: 14, messageId: 'a1', reasoningContent: '思考' }],
            },
            {
                role: 'assistant',
                reasoningContent: '调用前思考',
                toolCalls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"x"}' } }],
            },
            { role: 'tool', toolCallId: 'c1', toolName: 'get_weather', text: '晴', time: 15 },
            { role: 'tool', toolCallId: 'orphan', text: '孤立结果', time: 16 },
            { role: 'weird', text: '未知角色内容' },
        ],
    };
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextV2MigrateKeepsContent() {
        const result = buildLegacyEvents(legacyContext(), { now: 100 });
        const texts: string[] = [];
        for (const event of result.events) {
            if (event.kind === 'user' || event.kind === 'assistant') {
                for (const part of event.parts) if (part.type === 'text') texts.push(part.text);
            } else if (event.kind === 'event') {
                for (const part of event.parts) if (part.type === 'text') texts.push(part.text);
            } else if (event.kind === 'tool_result') {
                for (const part of event.parts) if (part.type === 'text') texts.push(part.text);
            }
        }
        assert.ok(texts.includes('原文A'), 'rawItems 原文 A 必须保留');
        assert.ok(texts.includes('原文B'), 'rawItems 原文 B 必须保留');
        assert.ok(texts.includes('普通消息'), '普通用户消息必须保留');
        assert.ok(texts.includes('有人撤回'), '系统事件必须保留');
        assert.ok(texts.includes('我来看看'), 'assistant 文本必须保留');
        assert.ok(texts.includes('晴'), '工具结果必须保留');
        assert.ok(texts.includes('孤立结果'), '孤儿工具结果必须保留');
        assert.ok(texts.includes('未知角色内容'), '未知 role 内容必须保留');
    },

    testContextV2MigrateDiagnostics() {
        const result = buildLegacyEvents(legacyContext(), { now: 100 });
        const kinds = result.events.map(e => e.kind);
        assert.deepEqual(kinds, [
            'user', 'user',          // rawItems
            'user',                  // 普通消息
            'event',                 // 系统事件
            'assistant',             // 文本回复
            'tool_call',             // 工具调用
            'tool_result',           // 匹配结果
            'tool_result',           // 孤儿结果
            'event',                 // 未知 role 保留
        ]);
        assert.deepEqual(result.events.map(e => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert.equal(result.nextSeq, 10);
        assert.equal(result.legacyIndex.archiveSeq, 2);
        assert.equal(result.legacyIndex.rawSeq, 3);
        assert.equal(result.legacyIndex.settledSeq, 1);
        assert.equal(result.legacyIndex.phase, 'flipped');

        const summary = result.records.filter(r => r.kind === 'summary') as Array<{ fromSeq: number; toSeq: number; text: string }>;
        assert.equal(summary.length, 1);
        assert.deepEqual([summary[0].fromSeq, summary[0].toSeq], [1, 2]);
        assert.equal(summary[0].text, '合并摘要（显示）');
    },

    testContextV2MigrateToolGrouping() {
        const result = buildLegacyEvents(legacyContext(), { now: 100 });
        const call = result.events.find(e => e.kind === 'tool_call') as any;
        const matched = result.events[6] as any;
        const orphan = result.events[7] as any;
        assert.equal(call.callId, 'c1');
        assert.equal(call.turnId, 'legacy-t:3');
        assert.equal(matched.kind, 'tool_result');
        assert.equal(matched.turnId, call.turnId);
        assert.equal(matched.groupId, call.groupId);
        assert.equal(orphan.groupId, 'legacy-orphan-g:5');
        assert.notEqual(orphan.groupId, call.groupId);
    },

    testContextV2MigrateRawTextSingle() {
        const result = buildLegacyEvents({
            messages: [{
                role: 'user',
                contentItems: [{ userId: 'QQ:1', messageId: 'x', time: 1, text: '压缩后显示', rawText: '完整原文' }],
            }],
        }, { now: 100 });
        assert.equal(result.events.length, 1);
        const user = result.events[0] as any;
        assert.equal(user.parts[0].text, '完整原文');
        const summary = result.records[0] as any;
        assert.equal(summary.fromSeq, 1);
        assert.equal(summary.toSeq, 1);
        assert.equal(summary.text, '压缩后显示');
    },

    testContextV2MigrateDeterministic() {
        const a = buildLegacyEvents(legacyContext(), { now: 100 });
        const b = buildLegacyEvents(legacyContext(), { now: 100 });
        assert.deepEqual(a, b);
    },

    testContextV2MigrateEmpty() {
        const result = buildLegacyEvents({}, { now: 100 });
        assert.deepEqual(result.events, []);
        assert.deepEqual(result.records, []);
        assert.equal(result.nextSeq, 1);
        assert.equal(result.legacyIndex.phase, 'flipped');
    },
};
