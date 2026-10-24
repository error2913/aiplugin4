// Context v2 门面单测：写入/投影/编译/召回/压缩/flush 重开。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';

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

let storage = new FakeStorage();

function installHost(): void {
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

async function openService(sid: string): Promise<ContextService> {
    storage = new FakeStorage();
    installHost();
    return ContextService.open(sid);
}

const estimateTextTokens = (text: string) => String(text || '').length;
const estimateEventTokens = () => 10;

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextServiceAppendAndProjection() {
        const service = await openService('QQ:service-1');
        service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '你好' }]);
        service.appendAssistant('a1', [{ type: 'text', text: '在' }]);
        service.appendSystem({ systemName: '事件', parts: [{ type: 'text', text: '撤回' }] });
        const projection = service.projection();
        assert.equal(projection.length, 3);
        assert.equal(projection[0].role, 'user');
        assert.equal(projection[1].role, 'assistant');
        assert.equal(projection[2].role, 'user');
        assert.equal(service.preview(2).length, 2);
    },

    async testContextServiceFlushAndReopen() {
        const sid = 'QQ:service-2';
        const service = await openService(sid);
        service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '持久化' }]);
        const flushed = await service.flush();
        assert.equal(flushed.ok, true);
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.projection().length, 1);
        assert.equal(reopened.head().nextSeq, 2);
    },

    async testContextServiceCompile() {
        const service = await openService('QQ:service-3');
        service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '一' }]);
        service.appendUser('QQ:1', 'm2', [{ type: 'text', text: '二' }]);
        const result = service.compile({
            budgetTokens: 1000,
            prefixMessages: [{ role: 'system', content: 'sys' }],
            estimateTextTokens,
            estimateEventTokens,
            resolveUserName: uid => uid,
        });
        assert.equal(result.messages[0].role, 'system');
        assert.equal(result.messages.length, 2);
        assert.equal(result.stats.unitsSelected, 1);
    },

    async testContextServiceRecall() {
        const sid = 'QQ:service-4';
        const service = await openService(sid);
        service.appendUser('QQ:1', 'm1', [{ type: 'text', text: 'needle 内容' }]);
        await service.flush();
        const raw = service.readRaw('e:1');
        assert.equal(raw.items.length, 1);
        assert.ok(raw.items[0].text.includes('needle'));
        const grep = service.grep('needle');
        assert.equal(grep.hits.length, 1);
        assert.equal(grep.hits[0].seq, 1);
    },

    async testContextServiceCompact() {
        const sid = 'QQ:service-5';
        const service = await openService(sid);
        for (let i = 1; i <= 4; i++) service.appendUser('QQ:1', `m${i}`, [{ type: 'text', text: `消息${i}` }]);
        const result = await service.compact(
            { batchTokens: 30, summaryMaxChars: 500 },
            {
                summarize: () => '这是摘要',
                estimateEventTokens,
                now: () => 100,
            },
        );
        assert.equal(result.advanced, true);
        assert.equal(result.record?.text, '这是摘要');
        await service.flush();
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().records.length, 1);
        assert.ok(reopened.head().summarizedThrough >= 2);
    },

    async testContextServiceShouldCompact() {
        storage = new FakeStorage();
        installHost();
        const service = await ContextService.open('QQ:service-6', { estimateEventTokens: () => 5 });
        service.appendUser('QQ:1', 'm1', [{ type: 'text', text: 'x' }]);
        assert.equal(service.shouldCompact(1), true);
        assert.equal(service.shouldCompact(0), false);
    },

    async testContextServiceMemoryBridge() {
        const service = await openService('QQ:service-7');
        service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '一' }]);
        service.appendAssistant('a1', [{ type: 'text', text: '二' }]);
        await service.flush();
        const recent = service.readRecent(1);
        assert.equal(recent.length, 1);
        assert.equal(recent[0].kind, 'assistant');
        const range = service.readRange(1, 2);
        assert.equal(range.items.length, 2);

        const batches: number[][] = [];
        const off = service.onAppended(batch => batches.push(batch.events.map(e => e.seq)));
        service.appendUser('QQ:1', 'm2', [{ type: 'text', text: '三' }]);
        service.appendUser('QQ:1', 'm3', [{ type: 'text', text: '四' }]);
        assert.deepEqual(batches, [[3], [4]], '每次追加通知一次，且不重复旧事件');
        off();
        service.appendUser('QQ:1', 'm4', [{ type: 'text', text: '五' }]);
        assert.equal(batches.length, 2, '取消订阅后不再通知');
    },
};
