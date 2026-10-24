// 影子对比单测：旧 messages 与 v2 projection 的规范化行一致/差异报告。
import assert from 'node:assert/strict';

import { compareRequests, compareShadow, formatRequestShadowReport, formatShadowReport, isRequestShadowEnabled, legacyLines, requestLines, setRequestShadowEnabled } from '../src/context/shadow';
import { mirrorAssistant, mirrorSystem, mirrorToolCalls, mirrorToolResult, mirrorUser } from '../src/context/mirror';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import type { MessageType } from '../src/context/types';

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

function installHost(): void {
    const storage = new FakeStorage();
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => Date.now() },
        fetch: (() => { throw new Error('no fetch'); }) as any,
        ext: {} as any,
    });
}

const legacy: MessageType[] = [
    { role: 'user', contentItems: [{ text: '你好', time: 1, userId: 'QQ:1', messageId: 'm1' }] },
    { role: 'assistant', contentItems: [{ text: '收到', time: 2, messageId: 'a1' }] },
    {
        role: 'assistant',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', text: '结果', toolCallId: 'c1', toolName: 'f' },
    { role: 'user', contentItems: [{ text: '撤回', time: 4, systemName: '事件' }] },
] as MessageType[];

async function seededProjection(): Promise<MessageType[]> {
    installHost();
    const service = await ContextService.open('QQ:shadow-test');
    mirrorUser(service, { uid: 'QQ:1', msgId: 'm1', text: '你好', at: 1 });
    mirrorAssistant(service, { msgId: 'a1', text: '收到', at: 2 });
    const mapping = mirrorToolCalls(service, {
        turnId: 't1',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] as any,
        at: 3,
    });
    mirrorToolResult(service, { callId: 'c1', toolName: 'f', text: '结果', group: mapping.get('c1') ?? null, at: 4 });
    mirrorSystem(service, { text: '撤回', systemName: '事件', at: 5 });
    return service.projection();
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextShadowEqual() {
        const projection = await seededProjection();
        const report = compareShadow(legacy, projection);
        assert.equal(report.equal, true, formatShadowReport(report));
        assert.deepEqual(report.diffs, []);
        assert.equal(report.legacyLines, 5);
    },

    async testContextShadowDiffReport() {
        const projection = await seededProjection();
        const changed = legacy.map(m => JSON.parse(JSON.stringify(m))) as MessageType[];
        (changed[0] as any).contentItems[0].text = '改过';
        const report = compareShadow(changed, projection);
        assert.equal(report.equal, false);
        assert.equal(report.diffs.length, 1);
        assert.equal(report.diffs[0].index, 0);
        assert.ok(formatShadowReport(report).includes('不一致'));
    },

    testContextShadowLegacyLinesNormalization() {
        const lines = legacyLines(legacy);
        assert.equal(lines[0], 'user:你好');
        assert.equal(lines[1], 'assistant:收到');
        assert.equal(lines[2], 'tool_call:c1:f:{}');
        assert.equal(lines[3], 'tool:c1:结果');
        assert.equal(lines[4], 'system:事件:撤回');
    },

    testContextShadowRequestFlag() {
        assert.equal(isRequestShadowEnabled(), false, '默认关闭，不影响生产请求');
        setRequestShadowEnabled(true);
        assert.equal(isRequestShadowEnabled(), true);
        setRequestShadowEnabled(false);
        assert.equal(isRequestShadowEnabled(), false);
    },

    testContextShadowRequestLinesAndCompare() {
        const legacyRequest = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '你好' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'c1', content: '结果' },
        ];
        const compiled = [
            { role: 'system', content: [{ type: 'text', text: 'sys' }] },
            { role: 'user', content: '你好' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: '结果' }] },
        ];
        const lines = requestLines(legacyRequest);
        assert.equal(lines[0], 'system:sys');
        assert.equal(lines[2], 'assistant:|tool_call:c1:f:{}');
        assert.equal(lines[3], 'tool:结果|tool_call_id:c1');
        const report = compareRequests(legacyRequest, compiled);
        assert.equal(report.equal, true, formatRequestShadowReport(report));
        assert.equal(report.legacyLines, 4);

        const changed = JSON.parse(JSON.stringify(compiled));
        changed[1].content = '改过';
        const diff = compareRequests(legacyRequest, changed);
        assert.equal(diff.equal, false);
        assert.equal(diff.diffs[0].index, 1);
    },
};
