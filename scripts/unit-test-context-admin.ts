// Context v2 管理操作单测：purge 置空/epoch 推进、hide 记录、stats、head 修复。
import assert from 'node:assert/strict';

import { contextStats, hideEvents, purgeSession, repairHead } from '../src/context/admin';
import { createEmptyHead, parseHead } from '../src/context/head';
import { eventPageKey, headKey } from '../src/context/keys';
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
    service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '一' }]);
    service.appendAssistant('a1', [{ type: 'text', text: '二' }]);
    assert.equal((await service.flush()).ok, true);
    return service;
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextAdminPurgeClearsAndAdvancesEpoch() {
        const sid = 'QQ:admin-purge';
        const service = await seed(sid);
        const head = service.head();
        assert.ok(storage.map.has(eventPageKey(sid, 1)));
        const result = purgeSession(sid, head);
        assert.ok(result.clearedEventPages >= 1);
        assert.equal(storage.map.get(eventPageKey(sid, 1)), '');
        assert.equal(result.head.epoch, head.epoch + 1);
        assert.equal(result.head.pageFloor, head.nextPageNo);
        assert.equal(result.head.summarizedThrough, result.head.epochStartSeq - 1);
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 0, 'purge 后新 store 无旧事件');
        assert.equal(reopened.head().epoch, head.epoch + 1);
        assert.equal(reopened.head().nextSeq, head.nextSeq, 'seq 不复用');
    },

    async testContextAdminHideAddsRedactAndHidesProjection() {
        const sid = 'QQ:admin-hide';
        const service = await seed(sid);
        hideEvents(service.getStore(), 'all', 100);
        assert.equal(service.snapshot().records.length, 1);
        assert.equal(service.projection().length, 0, 'hide all 后投影为空');
        await service.flush();
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.projection().length, 0);
    },

    async testContextAdminStats() {
        const sid = 'QQ:admin-stats';
        const service = await seed(sid);
        const stats = contextStats(service.getStore());
        assert.equal(stats.events, 2);
        assert.equal(stats.epoch, 1);
        assert.equal(stats.firstSeq, 1);
        assert.equal(stats.lastSeq, 2);
        assert.ok(stats.pages >= 1);
    },

    async testContextAdminRepairHead() {
        storage = new FakeStorage();
        installHost();
        const sid = 'QQ:admin-repair';
        const head = createEmptyHead();
        head.nextPageNo = 1;
        head.pageFloor = 99;
        storage.map.set(headKey(sid), JSON.stringify(head));
        const repaired = repairHead(sid);
        assert.ok(repaired);
        assert.equal(repaired!.pageFloor, 1, '非法 pageFloor 被修复');
        const stored = parseHead(storage.map.get(headKey(sid))!);
        assert.equal(stored?.pageFloor, 1);
        assert.equal(repairHead('QQ:missing'), null);
    },
};
