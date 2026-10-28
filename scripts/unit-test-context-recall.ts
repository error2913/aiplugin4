// Context v2 召回层单测（recall.ts）：e 地址/分页/msg_id/legacy/grep/可见性/坏页。
// 运行：独立入口（Lead 负责在 scripts/test-unit.cjs 注册 bundler entry），或在 Node 中
// 用 esbuild 打包后执行导出的 tests 对象。用 Map 假宿主 + 真 ContextStore。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import type { Host, HostStorage } from '../src/core/host';
import type { EventInput, RecordEntry } from '../src/context/events';
import { eventPageKey, legacyShardKey } from '../src/context/keys';
import { PageStoreError, readEventPage } from '../src/context/log/page_store';
import {
    eventRecallText,
    grepRaw,
    parseAddress,
    readLegacyShard,
    readRaw,
    RecallError,
} from '../src/context/recall';
import { ContextStore } from '../src/context/store';
import type { ContextSnapshot } from '../src/context/store';

const SID = 'QQ-Group:recall-test';

/** Map 存储桩：模拟海豹语义 —— 缺 key 时 storageGet 抛异常 */
class FakeStorage implements HostStorage {
    readonly map = new Map<string, string>();
    failGetOn: ((key: string) => boolean) | null = null;

    get(key: string): string | null {
        if (this.failGetOn && this.failGetOn(key)) throw new Error('storage backend read failed: disk I/O error');
        if (!this.map.has(key)) throw new Error('key not found（海豹：key 不存在时抛异常）');
        return this.map.get(key) ?? null;
    }

    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

function installFakeHost(): FakeStorage {
    const storage = new FakeStorage();
    setHost({
        storage,
        clock: { now: () => 1700000000000 },
        fetch: (() => {
            throw new Error('network disabled in unit test');
        }) as unknown as Host['fetch'],
        ext: {} as Host['ext'],
    });
    return storage;
}

function userInput(text: string, msgId: string): EventInput {
    return { kind: 'user', uid: 'QQ:1', msgId, parts: [{ type: 'text', text }] } as EventInput;
}

/** 新建 store → 追加 count 条 user 事件 → flush（flush 后事件一定落在 evt 页里） */
async function seedStore(
    count: number,
    makeText: (i: number) => string = i => `消息${i}`,
): Promise<{ storage: FakeStorage; store: ContextStore }> {
    const storage = installFakeHost();
    const store = await ContextStore.open(SID);
    const inputs: EventInput[] = [];
    for (let i = 1; i <= count; i += 1) inputs.push(userInput(makeText(i), `m${i}`));
    store.append(inputs);
    const flushed = await store.flush();
    assert.equal(flushed.ok, true, `seed flush 失败：${flushed.error ?? ''}`);
    return { storage, store };
}

async function reopen(loadRecentPages: number): Promise<ContextStore> {
    return ContextStore.open(SID, { loadRecentPages });
}

function snapshotOf(store: ContextStore): ContextSnapshot {
    return store.snapshot();
}

function needleText(i: number): string {
    return i % 100 === 0 ? `needle-${i}` : `普通-${i}`;
}

function hitSeqs(result: { hits: { seq: number }[] }): number[] {
    return result.hits.map(hit => hit.seq);
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextRecallParseAddress() {
        assert.deepEqual(parseAddress('e:5'), { kind: 'event', fromSeq: 5, toSeq: 5 });
        assert.deepEqual(parseAddress('e:9-3'), { kind: 'event', fromSeq: 3, toSeq: 9 });
        assert.deepEqual(parseAddress('arc:007'), { kind: 'legacy-shard', shardKind: 'arc', seq: 7 });
        assert.deepEqual(parseAddress('raw:3'), { kind: 'legacy-shard', shardKind: 'raw', seq: 3 });
        assert.deepEqual(parseAddress('blk:m1'), { kind: 'block', id: 'm1' });
        assert.deepEqual(parseAddress('m1'), { kind: 'msg', msgId: 'm1' });
        assert.deepEqual(parseAddress(''), { kind: 'unknown', raw: '' });
    },

    async testContextRecallReadSingleEventFromDisk() {
        await seedStore(600);
        const store = await reopen(1);   // 只加载最后一页 → 早期 seq 必须走磁盘
        const result = readRaw(store, snapshotOf(store), 'e:5');
        assert.equal(result.kind, 'events');
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].text.includes('消息5'), true);
        assert.equal(result.exhausted, true);
        assert.equal(result.cursor, null);
        assert.equal(result.total, 1);
    },

    async testContextRecallReadSingleEventFromSnapshot() {
        await seedStore(5);
        const store = await reopen(128);
        const result = readRaw(store, snapshotOf(store), 'e:5');
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].text.includes('消息5'), true);
        assert.equal(result.exhausted, true);
        assert.equal(result.total, 1);
    },

    async testContextRecallReadRangePaginationExhaustive() {
        await seedStore(1, () => 'A'.repeat(400));
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        const expected = eventRecallText(snapshot.events[0]);
        assert.ok(expected.length > 400);
        let cursor: { seq: number; offset: number } | null = null;
        let collected = '';
        let calls = 0;
        for (;;) {
            const result = readRaw(store, snapshot, 'e:1', { maxChars: 100, maxItems: 20, cursor });
            calls += 1;
            for (const item of result.items) collected += item.text;
            if (result.exhausted) break;
            assert.ok(result.cursor, '未穷尽时必须返回 cursor');
            cursor = result.cursor;
            assert.ok(calls < 20, '分页应在合理次数内穷尽');
        }
        assert.equal(collected, expected, '分页拼回应与完整原文一致（不重复、不丢字）');
        assert.ok(calls >= 4, `400+ 字 / 100 字符预算应需要多次调用（实际 ${calls}）`);
    },

    async testContextRecallReadMsgId() {
        await seedStore(5);
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        const found = readRaw(store, snapshot, 'm3');
        assert.equal(found.items.length, 1);
        assert.equal(found.items[0].text.includes('消息3'), true);
        assert.equal(found.total, 1);
        const missing = readRaw(store, snapshot, 'm-not-exist');
        assert.equal(missing.items.length, 0);
        assert.equal(missing.exhausted, true);
        assert.ok(String(missing.note).includes('msg_id=m-not-exist not found (may be cleaned up or belong to another session)'));
    },

    async testContextRecallBadPageSkipped() {
        const { storage } = await seedStore(600);
        const page2Start = readEventPage(SID, 2)?.seqStart;
        assert.ok(typeof page2Start === 'number' && page2Start > 1, '应有第 2 页');
        storage.map.set(eventPageKey(SID, 1), '{bad json');   // 页损坏（半页）
        const store = await reopen(1);                         // 只加载最后一页
        const result = readRaw(store, snapshotOf(store), 'e:1-600', { maxChars: 10_000_000, maxItems: 10_000 });
        assert.deepEqual(result.skippedPages, [1], '坏页应被记录而不是抛错');
        assert.ok(result.items.length > 0, '坏页之后的页仍应可读');
        assert.equal(result.items[0].seq, page2Start, '应从坏页之后的第一页开始返回');
        assert.ok(String(result.note).includes('missing/corrupt pages: 1 (1)'));
    },

    async testContextRecallMissingPageSkipped() {
        const { storage } = await seedStore(600);
        const page2Start = readEventPage(SID, 2)?.seqStart;
        assert.ok(typeof page2Start === 'number' && page2Start > 1, '应有第 2 页');
        storage.map.delete(eventPageKey(SID, 1));              // 页已清理（缺失）
        const store = await reopen(1);
        const result = readRaw(store, snapshotOf(store), 'e:1-600', { maxChars: 10_000_000, maxItems: 10_000 });
        assert.deepEqual(result.skippedPages, [1]);
        assert.equal(result.items[0].seq, page2Start);
    },

    async testContextRecallReadFailureThrows() {
        const { storage } = await seedStore(600);
        const store = await reopen(1);
        storage.failGetOn = key => key === eventPageKey(SID, 1);
        assert.throws(() => readRaw(store, snapshotOf(store), 'e:5'), (error: unknown) => {
            assert.ok(error instanceof PageStoreError, '读失败应抛 PageStoreError（不是当缺页吞掉）');
            assert.equal((error as PageStoreError).code, 'READ_FAILED');
            return true;
        });
    },

    async testContextRecallRedactedHidden() {
        await seedStore(10);
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        const redact: RecordEntry = { kind: 'redact', id: 'rd1', at: 100, epoch: 1, fromSeq: 2, toSeq: 3, target: 'all' };
        store.appendRecord(redact);
        const after = snapshotOf(store);
        const hidden = readRaw(store, after, 'e:2');
        assert.equal(hidden.items.length, 0);
        assert.ok(String(hidden.note).includes('events hidden by record index (epoch/redact)'));
        const visible = readRaw(store, after, 'e:4');
        assert.equal(visible.items.length, 1);
        assert.ok(snapshot.events.length > 0);
    },

    async testContextRecallLegacyShards() {
        const { storage } = await seedStore(1);
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        storage.map.set(legacyShardKey(SID, 'arc', 1), JSON.stringify({
            seq: 1, from: 1, to: 2,
            items: [
                { messageId: 'old1', userId: 'QQ:2', time: 1, text: '旧归档原文' },
                { messageId: 'old2', userId: 'QQ:2', time: 2, text: '第二条' },
            ],
        }));
        const arc = readRaw(store, snapshot, 'arc:1', { maxChars: 3, maxItems: 1 });
        assert.equal(arc.kind, 'legacy-shard');
        assert.equal(arc.items.length, 1);
        assert.equal(arc.items[0].text, '旧归档');
        assert.equal(arc.total, 2);
        assert.ok(arc.cursor);
        // 续读穷尽：拼回完整文本
        let cursor = arc.cursor;
        let collected = arc.items.map(item => item.text).join('');
        for (;;) {
            const next = readRaw(store, snapshot, 'arc:1', { maxChars: 3, maxItems: 1, cursor });
            collected += next.items.map(item => item.text).join('');
            if (next.exhausted) break;
            cursor = next.cursor;
            assert.ok(cursor, '旧分片分页必须返回 cursor');
        }
        assert.equal(collected, '旧归档原文第二条');
        // 损坏 / 缺失
        storage.map.set(legacyShardKey(SID, 'raw', 2), '{bad');
        const broken = readRaw(store, snapshot, 'raw:2');
        assert.equal(broken.items.length, 0);
        assert.ok(String(broken.note).includes('legacy shard missing, cleaned up, or corrupted'));
        const missing = readRaw(store, snapshot, 'raw:9');
        assert.equal(missing.items.length, 0);
        assert.equal(readLegacyShard(SID, 'arc', 1)?.length, 2);
        assert.equal(readLegacyShard(SID, 'arc', 9), null);
    },

    async testContextRecallBlockAndUnknown() {
        await seedStore(1);
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        const block = readRaw(store, snapshot, 'blk:m1');
        assert.equal(block.kind, 'block');
        assert.ok(String(block.note).includes('read-only compatibility for legacy block blk:m1 is not wired yet'));
        const unknown = readRaw(store, snapshot, '');
        assert.equal(unknown.kind, 'unknown');
        assert.ok(String(unknown.note).includes('unrecognized recall address'));
    },

    async testContextRecallGrepFindsHits() {
        await seedStore(600, needleText);
        const store = await reopen(128);
        const result = grepRaw(store, snapshotOf(store), 'needle', { maxHits: 100, maxPages: 10 });
        assert.deepEqual(hitSeqs(result), [100, 200, 300, 400, 500, 600]);
        assert.equal(result.hits[0].pointer, 'read_raw id=e:100');
        assert.ok(result.hits[0].snippet.includes('needle-100'));
        assert.equal(result.exhausted, true);
    },

    async testContextRecallGrepPaginationExhaustive() {
        await seedStore(600, needleText);
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        let cursor: { pageNo: number; beforeSeq?: number } | null = null;
        const seqs: number[] = [];
        let calls = 0;
        for (;;) {
            const result = grepRaw(store, snapshot, 'needle', { maxPages: 1, maxHits: 2, cursor });
            calls += 1;
            seqs.push(...hitSeqs(result));
            if (result.exhausted) break;
            assert.ok(result.nextCursor, '未穷尽时必须返回 nextCursor');
            cursor = result.nextCursor;
            assert.ok(calls < 30, 'grep 分页应在合理次数内穷尽');
        }
        assert.deepEqual(seqs.slice().sort((a, b) => a - b), [100, 200, 300, 400, 500, 600], '翻页结果不重复、不遗漏');
        assert.ok(calls > 1);
    },

    async testContextRecallGrepRegexAndInvalid() {
        await seedStore(600, needleText);
        const store = await reopen(128);
        const snapshot = snapshotOf(store);
        const regex = grepRaw(store, snapshot, '^.*needle-\\d{3}$', { regex: true, maxHits: 100 });
        assert.deepEqual(hitSeqs(regex), [100, 200, 300, 400, 500, 600]);
        assert.throws(() => grepRaw(store, snapshot, '[', { regex: true }), (error: unknown) => {
            assert.ok(error instanceof RecallError);
            assert.equal((error as RecallError).code, 'INVALID_ARGUMENT');
            return true;
        });
    },

    async testContextRecallGrepSkipsRedactedSupersededKeepsSummary() {
        await seedStore(10, i => `p${i}`);
        const store = await reopen(128);
        store.appendRecord({ kind: 'redact', id: 'rd1', at: 100, epoch: 1, fromSeq: 2, toSeq: 3, target: 'all' });
        store.appendRecord({ kind: 'supersede', id: 'sp1', at: 101, dedupKey: 'u:m4', seq: 9 });
        store.appendRecord({ kind: 'summary', id: 'sm1', at: 102, epoch: 1, fromSeq: 1, toSeq: 6, text: '摘要' });
        const result = grepRaw(store, snapshotOf(store), 'p', { maxHits: 100 });
        assert.deepEqual(hitSeqs(result), [1, 5, 6, 7, 8, 9, 10], 'redact(2,3)/supersede(4) 跳过；摘要覆盖的 1 仍可搜；输出按时间升序');
        assert.ok(String(result.note).includes('skipped 3 invisible events (epoch/redact/supersede)'));
    },

    async testContextRecallGrepAppliesEdit() {
        await seedStore(10, i => `p${i}`);
        const store = await reopen(128);
        store.appendRecord({ kind: 'edit', id: 'ed1', at: 100, seq: 5, parts: [{ type: 'text', text: 'EDITED-ONLY' }] });
        const snapshot = snapshotOf(store);
        const edited = grepRaw(store, snapshot, 'EDITED-ONLY');
        assert.deepEqual(hitSeqs(edited), [5]);
        const original = grepRaw(store, snapshot, 'p5');
        assert.deepEqual(hitSeqs(original), [], 'edit 后旧文本不应再命中');
    },

    async testContextRecallGrepBadPageSkipped() {
        const { storage } = await seedStore(600, needleText);
        const page2 = readEventPage(SID, 2);
        assert.ok(page2, '应有第 2 页');
        const needleSeqsInPage2 = new Set(
            page2!.events
                .filter(event => eventRecallText(event).includes('needle'))
                .map(event => event.seq),
        );
        storage.map.set(eventPageKey(SID, 2), '{broken');
        const store = await reopen(128);
        const result = grepRaw(store, snapshotOf(store), 'needle', { maxHits: 100, maxPages: 10 });
        assert.deepEqual(result.skippedPages, [2]);
        const expected = [100, 200, 300, 400, 500, 600].filter(seq => !needleSeqsInPage2.has(seq)).sort((a, b) => a - b);
        assert.ok(expected.length > 0 && expected.length < 6, '第 2 页应至少包含部分命中，用于验证跳过');
        assert.deepEqual(hitSeqs(result), expected, '坏页范围内的命中缺失但其余命中保留');
    },

    async testContextRecallGrepBounds() {
        await seedStore(600, needleText);
        const store = await reopen(128);
        const result = grepRaw(store, snapshotOf(store), 'needle', { fromSeq: 300, toSeq: 400, maxHits: 100 });
        assert.deepEqual(hitSeqs(result), [300, 400]);
        const narrow = grepRaw(store, snapshotOf(store), 'needle', { fromSeq: 300, toSeq: 350, maxHits: 100 });
        assert.deepEqual(hitSeqs(narrow), [300]);
        const empty = grepRaw(store, snapshotOf(store), 'needle', { fromSeq: 301, toSeq: 399, maxHits: 100 });
        assert.deepEqual(hitSeqs(empty), []);
        assert.equal(empty.exhausted, true);
    },
};
