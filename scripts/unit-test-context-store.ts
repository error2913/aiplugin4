// Context v2 Store 单测：同步 append、eventId 去重、增量 flush、恢复、记录页。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import { ContextStore, loadHead } from '../src/context/store';
import { parseHead } from '../src/context/head';
import { eventPageKey, headKey } from '../src/context/keys';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';

class FakeStorage {
    map = new Map<string, string>();
    failKeyPart: string | null = null;
    get(key: string): string {
        if (!this.map.has(key)) throw new Error(`key not found: ${key}`);
        return this.map.get(key)!;
    }
    set(key: string, value: string): void {
        if (this.failKeyPart && key.includes(this.failKeyPart)) throw new Error(`模拟写失败: ${key}`);
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
        fetch: (() => { throw new Error('no fetch in unit test'); }) as any,
        ext: {} as any,
    });
}

function resetHost(): void {
    storage = new FakeStorage();
    installHost();
}

const userInput = (id: string, text = 'hi') => ({
    kind: 'user' as const,
    uid: 'QQ:1',
    msgId: id,
    parts: [{ type: 'text' as const, text }],
});

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextStoreAppendAssignsSeqAndDedup() {
        resetHost();
        const store = await ContextStore.open('QQ-Group:store-basic');
        const seqs = store.append([userInput('m1'), userInput('m2')]);
        assert.deepEqual(seqs, [1, 2]);
        const dup = store.append([userInput('m1')]);
        assert.deepEqual(dup, []);
        const head = store.getHead();
        assert.equal(head.nextSeq, 3);
        assert.equal(store.snapshot().events.length, 2);
    },

    async testContextStoreFlushWritesOnceAndReloads() {
        resetHost();
        const sid = 'QQ-Group:store-flush';
        const store = await ContextStore.open(sid);
        store.append([userInput('m1'), userInput('m2')]);
        const result = await store.flush();
        assert.equal(result.ok, true);
        assert.ok(result.writtenEventPages >= 1);
        assert.ok(storage.map.has(eventPageKey(sid, 1)));
        const head = parseHead(storage.map.get(headKey(sid))!);
        assert.ok(head);
        assert.equal(head!.nextPageNo, 2);
        assert.equal(head!.persistedSeq, 2);

        // 重新打开：只靠存储恢复
        const reopened = await ContextStore.open(sid);
        assert.deepEqual(reopened.snapshot().events.map(e => e.seq), [1, 2]);
        assert.equal(reopened.getHead().nextPageNo, 2);
        assert.equal(reopened.getHead().nextSeq, 3);
    },

    async testContextStoreFlushFailureKeepsBufferAndRetries() {
        resetHost();
        const sid = 'QQ-Group:store-retry';
        const store = await ContextStore.open(sid);
        store.append([userInput('m1')]);
        storage.failKeyPart = 'evt:';
        const failed = await store.flush();
        assert.equal(failed.ok, false);
        assert.equal(loadHead(sid) === null, true, 'head 未推进（失败不写 head）');
        assert.equal(store.snapshot().events.length, 1, '内存事件仍在');
        storage.failKeyPart = null;
        const ok = await store.flush();
        assert.equal(ok.ok, true);
        const reopened = await ContextStore.open(sid);
        assert.deepEqual(reopened.snapshot().events.map(e => e.seq), [1]);
    },

    async testContextStoreRecoverPagesBeyondHead() {
        resetHost();
        const sid = 'QQ-Group:store-recover';
        const store = await ContextStore.open(sid);
        store.append([userInput('m1')]);
        assert.equal((await store.flush()).ok, true);
        // 模拟「页已写、head 未推进」：把 head 回退到 nextPageNo=1/persisted=0
        const stored = parseHead(storage.map.get(headKey(sid))!)!;
        stored.nextPageNo = 1;
        stored.persistedSeq = 0;
        storage.map.set(headKey(sid), JSON.stringify(stored));

        const reopened = await ContextStore.open(sid);
        assert.deepEqual(reopened.snapshot().events.map(e => e.seq), [1]);
        assert.equal(reopened.getHead().nextPageNo, 2);
        assert.equal(reopened.getHead().persistedSeq, 1);
    },

    async testContextStoreRecordsPersist() {
        resetHost();
        const sid = 'QQ-Group:store-record';
        const store = await ContextStore.open(sid);
        store.append([userInput('m1')]);
        store.appendRecord({
            kind: 'summary',
            id: 'sum:1',
            at: 10,
            epoch: 1,
            fromSeq: 1,
            toSeq: 1,
            text: '摘要',
        });
        const result = await store.flush();
        assert.equal(result.ok, true);
        assert.ok(result.writtenRecordPages >= 1);
        const reopened = await ContextStore.open(sid);
        assert.equal(reopened.snapshot().records.length, 1);
        assert.equal(reopened.snapshot().records[0].kind, 'summary');
    },

    async testContextStoreSnapshotVersion() {
        resetHost();
        const store = await ContextStore.open('QQ-Group:store-version');
        const v0 = store.snapshot().version;
        store.append([userInput('m1')]);
        const v1 = store.snapshot().version;
        assert.ok(v1 > v0);
        store.append([userInput('m2')]);
        assert.ok(store.snapshot().version > v1);
    },

    async testContextStoreEmptyOpen() {
        resetHost();
        const store = await ContextStore.open('QQ-Group:store-empty');
        assert.equal(store.snapshot().events.length, 0);
        assert.equal(store.getHead().nextSeq, 1);
        assert.equal(loadHead('QQ-Group:store-empty'), null);
    },
};
