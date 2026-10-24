// Context v2 变更原语单测：编辑 parts、文本替换、去重覆盖与视图生效。
import assert from 'node:assert/strict';

import { editEventParts, replaceEventText, supersedeEvent } from '../src/context/mutations';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';

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

async function seed(sid: string): Promise<ContextService> {
    storage = new FakeStorage();
    installHost();
    const service = await ContextService.open(sid);
    service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '原始 内容 A' }]);
    service.appendUser('QQ:2', 'm2', [{ type: 'text', text: '第二条' }]);
    assert.equal((await service.flush()).ok, true);
    return service;
}

function projectionText(service: ContextService): string {
    return JSON.stringify(service.projection());
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextMutationsEditParts() {
        const service = await seed('QQ:mut-edit');
        assert.equal(editEventParts(service.getStore(), 1, [{ type: 'text', text: '替换后的内容' }], 100), true);
        assert.ok(projectionText(service).includes('替换后的内容'));
        assert.equal(editEventParts(service.getStore(), 999, [{ type: 'text', text: 'x' }]), false, '不存在的事件不写记录');
        assert.equal(service.snapshot().records.length, 1);
    },

    async testContextMutationsReplaceText() {
        const service = await seed('QQ:mut-replace');
        const first = replaceEventText(service.getStore(), 1, '内容', '文本', { now: 100 });
        assert.equal(first, 1);
        assert.ok(projectionText(service).includes('原始 文本 A'));
        const miss = replaceEventText(service.getStore(), 1, '不存在', 'x');
        assert.equal(miss, 0);
        const all = replaceEventText(service.getStore(), 1, ' ', '-', { all: true, now: 101 });
        assert.equal(all, 2);
        assert.ok(projectionText(service).includes('原始-文本-A'));
    },

    async testContextMutationsSupersede() {
        const service = await seed('QQ:mut-supersede');
        // user 事件的 dedupKey = eventId；后到 seq2 覆盖先到 seq1
        supersedeEvent(service.getStore(), 'u:m1', 2, 100);
        await service.flush();
        const text = projectionText(service);
        assert.equal(text.includes('原始 内容 A'), false, '被覆盖事件不应出现在视图');
        assert.ok(text.includes('第二条'));
    },
};
