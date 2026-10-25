// Context v2 页存储单测（log/page_store.ts + log/record_store.ts）。
// 覆盖：缺失 vs 读失败、写入失败、只写一次（不覆盖）、半页/损坏页、恢复探测、页号/seq 连续性、
// 记录页读写与全量加载、批量读写、页大小上限。
// 运行：`npm run test:unit`（本文件需在 scripts/test-unit.cjs 注册入口后才能被 runner 收集；
// 也可用 esbuild 打包后单独执行 tests 对象）。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import type { Host, HostStorage } from '../src/core/host';
import type { ConversationEvent, RecordEntry } from '../src/context/events';
import { eventPageKey, recordPageKey } from '../src/context/keys';
import {
    buildEventPage,
    EVENT_PAGE_MAX_BYTES,
    measureEventPageBytes,
    isMissingKeyError,
    PageStoreError,
    readEventPage,
    readEventPages,
    recoverEventPages,
    setMissingKeyErrorDetector,
    writeEventPage,
    writeEventPages,
} from '../src/context/log/page_store';
import {
    buildRecordPage,
    loadRecordPages,
    measureRecordPageBytes,
    readRecordPage,
    RECORD_PAGE_MAX_BYTES,
    writeRecordPage,
} from '../src/context/log/record_store';

const SID = 'QQ-Group:page-test';

/** Map 存储桩：模拟海豹语义 —— 缺 key 时 storageGet 抛异常 */
class FakeStorage implements HostStorage {
    readonly map = new Map<string, string>();
    readonly writes: string[] = [];
    failSetOn: ((key: string) => boolean) | null = null;
    failGetOn: ((key: string) => boolean) | null = null;
    /** 直接指定 get 抛出的异常（用于验证缺失判定器覆盖） */
    getErrorOverride: Error | null = null;

    get(key: string): string | null {
        if (this.getErrorOverride) throw this.getErrorOverride;
        if (this.failGetOn && this.failGetOn(key)) throw new Error('storage backend read failed: disk I/O error');
        if (!this.map.has(key)) throw new Error('key not found（海豹：key 不存在时抛异常）');
        return this.map.get(key) ?? null;
    }

    set(key: string, value: string): void {
        if (this.failSetOn && this.failSetOn(key)) throw new Error('storage set failed: disk full');
        this.writes.push(key);
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

function expectPageError(fn: () => unknown, code: string): void {
    assert.throws(fn, (error: unknown) => {
        assert.ok(error instanceof PageStoreError, `应抛 PageStoreError，实际：${String(error)}`);
        assert.equal((error as PageStoreError).code, code);
        return true;
    });
}

function userEvent(seq: number, text = `第${seq}条`): ConversationEvent {
    return {
        seq,
        eventId: `u:m${seq}`,
        at: 1000 + seq,
        recvAt: 1000 + seq,
        kind: 'user',
        uid: 'QQ:1',
        msgId: `m${seq}`,
        parts: [{ type: 'text', text }],
    } as ConversationEvent;
}

function seedPage(storage: FakeStorage, seqStart: number, endSeq: number, pageNo = seqStart): void {
    const events: ConversationEvent[] = [];
    for (let seq = seqStart; seq <= endSeq; seq += 1) events.push(userEvent(seq));
    const page = buildEventPage(pageNo, events);
    storage.map.set(eventPageKey(SID, pageNo), JSON.stringify(page));
}

function summaryRecord(id: string, fromSeq: number, toSeq: number): RecordEntry {
    return { id, at: 1000, kind: 'summary', epoch: 1, fromSeq, toSeq, text: `摘要${id}` } as RecordEntry;
}

function editRecord(id: string, seq: number): RecordEntry {
    return { id, at: 1001, kind: 'edit', seq, parts: [{ type: 'text', text: '改写' }] } as RecordEntry;
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextLogMissingKeyReturnsNull() {
        const storage = installFakeHost();
        assert.equal(readEventPage(SID, 1), null, '缺 key 应返回 null（缺失不是读失败）');
        assert.equal(readRecordPage(SID, 1), null, '记录页缺 key 应返回 null');
        assert.equal(storage.writes.length, 0);
    },

    testContextLogReadFailureThrows() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2);
        storage.failGetOn = key => key.startsWith('evt:');
        expectPageError(() => readEventPage(SID, 1), 'READ_FAILED');
    },

    testContextLogWriteOnceNoOverwrite() {
        const storage = installFakeHost();
        const page = buildEventPage(1, [userEvent(1), userEvent(2)]);
        assert.equal(writeEventPage(SID, page), 'written');
        const key = eventPageKey(SID, 1);
        const firstContent = storage.map.get(key);
        const writesAfterFirst = storage.writes.length;
        assert.equal(writeEventPage(SID, page), 'exists', '已存在页应返回 exists');
        assert.equal(storage.map.get(key), firstContent, '已存在页不得被覆盖');
        assert.equal(storage.writes.length, writesAfterFirst, 'exists 不应产生写入');
        assert.equal(readEventPage(SID, 1)?.seqEnd, 2);
    },

    testContextLogWriteFailureReturnsFailedThenRetry() {
        const storage = installFakeHost();
        storage.failSetOn = key => key.startsWith('evt:');
        assert.equal(writeEventPage(SID, buildEventPage(1, [userEvent(1)])), 'failed');
        assert.equal(storage.map.has(eventPageKey(SID, 1)), false);
        storage.failSetOn = null;
        assert.equal(writeEventPage(SID, buildEventPage(1, [userEvent(1)])), 'written', '存储恢复后应可重试写入');
    },

    testContextLogWriteProbeReadFailureKeepsPage() {
        const storage = installFakeHost();
        storage.failGetOn = key => key.startsWith('evt:');
        assert.equal(writeEventPage(SID, buildEventPage(1, [userEvent(1)])), 'failed', '读探测失败时不得冒险覆盖');
        assert.equal(storage.writes.length, 0, '探测失败不应写入');
    },

    testContextLogHalfPageThrows() {
        const storage = installFakeHost();
        storage.map.set(eventPageKey(SID, 1), '{"pageNo":1,"seqStart":1,"seqEnd":2,"bytes":10,"events":[');
        expectPageError(() => readEventPage(SID, 1), 'INVALID_PAGE');
        storage.map.set(recordPageKey(SID, 1), '{"pageNo":1,"entries":');
        expectPageError(() => readRecordPage(SID, 1), 'INVALID_PAGE');
    },

    testContextLogPageNoMismatchThrows() {
        const storage = installFakeHost();
        const page2 = buildEventPage(2, [userEvent(1)]);
        storage.map.set(eventPageKey(SID, 1), JSON.stringify(page2));
        expectPageError(() => readEventPage(SID, 1), 'INVALID_PAGE');
        const rec2 = buildRecordPage(2, [summaryRecord('r2', 1, 1)]);
        storage.map.set(recordPageKey(SID, 1), JSON.stringify(rec2));
        expectPageError(() => readRecordPage(SID, 1), 'INVALID_PAGE');
    },

    testContextLogSeqDiscontinuityThrows() {
        const storage = installFakeHost();
        const broken = {
            pageNo: 1,
            seqStart: 1,
            seqEnd: 5,
            events: [userEvent(1), userEvent(5)],
        };
        const payload = { pageNo: broken.pageNo, seqStart: broken.seqStart, seqEnd: broken.seqEnd, events: broken.events };
        storage.map.set(eventPageKey(SID, 1), JSON.stringify({ ...payload, bytes: measureEventPageBytes(payload) }));
        expectPageError(() => readEventPage(SID, 1), 'INVALID_PAGE');
    },

    testContextLogPageBytesSelfDescriptionThrows() {
        const storage = installFakeHost();
        const page = buildEventPage(1, [userEvent(1)]);
        storage.map.set(eventPageKey(SID, 1), JSON.stringify({ ...page, bytes: page.bytes + 1 }));
        expectPageError(() => readEventPage(SID, 1), 'INVALID_PAGE');
    },

    testContextLogPageLimits() {
        const storage = installFakeHost();
        const tooMany: ConversationEvent[] = [];
        for (let seq = 1; seq <= 257; seq += 1) tooMany.push(userEvent(seq));
        expectPageError(() => buildEventPage(1, tooMany), 'INVALID_ARGUMENT');
        expectPageError(() => buildEventPage(1, []), 'INVALID_ARGUMENT');

        const huge = 'x'.repeat(EVENT_PAGE_MAX_BYTES + 100);
        expectPageError(() => buildEventPage(1, [userEvent(1, huge)]), 'INVALID_ARGUMENT');

        // 读侧：外部写入的超大页（绕过 build）应判损坏，而不是当缺失
        const oversized = { pageNo: 1, seqStart: 1, seqEnd: 1, events: [userEvent(1, 'x'.repeat(EVENT_PAGE_MAX_BYTES + 100))] };
        storage.map.set(eventPageKey(SID, 1), JSON.stringify({ ...oversized, bytes: measureEventPageBytes(oversized) }));
        expectPageError(() => readEventPage(SID, 1), 'INVALID_PAGE');
    },

    testContextLogExistingPageConflictThrows() {
        const storage = installFakeHost();
        assert.equal(writeEventPage(SID, buildEventPage(1, [userEvent(1), userEvent(2)])), 'written');
        expectPageError(() => writeEventPage(SID, buildEventPage(1, [userEvent(5), userEvent(6)])), 'INVALID_PAGE');
        assert.equal(readEventPage(SID, 1)?.seqStart, 1, '冲突时不得覆盖既有页');
    },

    testContextLogRecoverAdoptsWrittenPages() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2);
        seedPage(storage, 3, 4, 2);
        const recovered = recoverEventPages(SID, { nextPageNo: 1, persistedSeq: 0 });
        assert.equal(recovered.pages.length, 2);
        assert.equal(recovered.nextPageNo, 3);
        assert.equal(recovered.persistedSeq, 4);
        assert.equal(recovered.stoppedBy, 'missing');
        // head 落后（页已写、head 未推进）：幂等采纳同一批页
        const lagging = recoverEventPages(SID, { nextPageNo: 2, persistedSeq: 2 });
        assert.equal(lagging.pages.length, 1);
        assert.equal(lagging.pages[0].pageNo, 2);
        assert.equal(lagging.nextPageNo, 3);
        assert.equal(lagging.persistedSeq, 4);
    },

    testContextLogRecoverStopsAtMissing() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2, 1);
        seedPage(storage, 5, 6, 3);   // 页 2 缺失（模拟清理/未写）
        const recovered = recoverEventPages(SID, { nextPageNo: 1, persistedSeq: 0 });
        assert.equal(recovered.pages.length, 1);
        assert.equal(recovered.pages[0].pageNo, 1);
        assert.equal(recovered.nextPageNo, 2);
        assert.equal(recovered.persistedSeq, 2);
        assert.equal(recovered.stoppedBy, 'missing');
    },

    testContextLogRecoverRespectsLimit() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2, 1);
        seedPage(storage, 3, 4, 2);
        seedPage(storage, 5, 6, 3);
        const recovered = recoverEventPages(SID, { nextPageNo: 1, persistedSeq: 0 }, { maxPages: 2 });
        assert.equal(recovered.pages.length, 2);
        assert.equal(recovered.nextPageNo, 3);
        assert.equal(recovered.persistedSeq, 4);
        assert.equal(recovered.stoppedBy, 'limit');
    },

    testContextLogRecoverSeqGapThrows() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2, 1);
        seedPage(storage, 5, 6, 2);   // 页号连续但 seq 不连续 → 数据损坏
        expectPageError(() => recoverEventPages(SID, { nextPageNo: 1, persistedSeq: 0 }), 'INVALID_PAGE');
    },

    testContextLogBatchReadReportsMissing() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2, 1);
        seedPage(storage, 3, 4, 2);
        seedPage(storage, 5, 6, 3);
        storage.map.delete(eventPageKey(SID, 2));
        const result = readEventPages(SID, 1, 3);
        assert.equal(result.pages.length, 2);
        assert.deepEqual(result.pages.map(page => page.pageNo), [1, 3]);
        assert.deepEqual(result.missingPageNos, [2]);
    },

    testContextLogBatchReadReadFailureThrows() {
        const storage = installFakeHost();
        seedPage(storage, 1, 2, 1);
        seedPage(storage, 3, 4, 2);
        storage.failGetOn = key => key === eventPageKey(SID, 2);
        expectPageError(() => readEventPages(SID, 1, 2), 'READ_FAILED');
    },

    testContextLogBatchWriteStopsOnFailure() {
        const storage = installFakeHost();
        storage.failSetOn = key => key === eventPageKey(SID, 2);
        const result = writeEventPages(SID, [buildEventPage(1, [userEvent(1)]), buildEventPage(2, [userEvent(2)]), buildEventPage(3, [userEvent(3)])]);
        assert.equal(result.written, 1);
        assert.equal(result.exists, 0);
        assert.equal(result.failedPageNo, 2);
        assert.equal(storage.map.has(eventPageKey(SID, 3)), false, '失败后不得继续写后续页');
    },

    testContextLogRecordPageRoundTrip() {
        const storage = installFakeHost();
        const page = buildRecordPage(1, [summaryRecord('r1', 1, 3), editRecord('r2', 2)]);
        assert.ok(page.bytes > 0);
        assert.equal(writeRecordPage(SID, page), 'written');
        const read = readRecordPage(SID, 1);
        assert.ok(read);
        assert.equal(read!.pageNo, 1);
        assert.equal(read!.bytes, page.bytes);
        assert.deepEqual(read!.entries, page.entries);
        assert.equal(writeRecordPage(SID, page), 'exists');
    },

    testContextLogRecordPageWriteFailure() {
        const storage = installFakeHost();
        storage.failSetOn = key => key.startsWith('rec:');
        assert.equal(writeRecordPage(SID, buildRecordPage(1, [summaryRecord('r1', 1, 2)])), 'failed');
        assert.equal(storage.writes.length, 0);
    },

    testContextLogRecordPageValidation() {
        const storage = installFakeHost();
        expectPageError(() => buildRecordPage(1, []), 'INVALID_ARGUMENT');
        expectPageError(() => buildRecordPage(1, [{ id: 'x', at: 1, kind: 'bogus' } as unknown as RecordEntry]), 'INVALID_PAGE');
        expectPageError(() => buildRecordPage(1, [{ id: '', at: 1, kind: 'summary', epoch: 1, fromSeq: 1, toSeq: 2, text: '' } as RecordEntry]), 'INVALID_PAGE');
        expectPageError(() => buildRecordPage(1, [{ id: 'r', at: 1, kind: 'summary', epoch: 1, fromSeq: 3, toSeq: 1, text: '' } as RecordEntry]), 'INVALID_PAGE');
        expectPageError(() => buildRecordPage(1, [{ id: 'r', at: 1, kind: 'redact', epoch: 1, fromSeq: 1, toSeq: 2, target: 'nobody' } as unknown as RecordEntry]), 'INVALID_PAGE');
        expectPageError(() => buildRecordPage(1, [{ id: 'r', at: 1, kind: 'summary', epoch: 1, fromSeq: 1, toSeq: 2, text: 'x'.repeat(RECORD_PAGE_MAX_BYTES + 100) } as RecordEntry]), 'INVALID_ARGUMENT');
        const big = { pageNo: 1, entries: [summaryRecord('r1', 1, 2)] };
        storage.map.set(recordPageKey(SID, 1), JSON.stringify({ ...big, entries: [{ ...summaryRecord('r1', 1, 2), text: 'x'.repeat(RECORD_PAGE_MAX_BYTES + 100) }], bytes: measureRecordPageBytes({ pageNo: 1, entries: [{ ...summaryRecord('r1', 1, 2), text: 'x'.repeat(RECORD_PAGE_MAX_BYTES + 100) }] }) }));
        expectPageError(() => readRecordPage(SID, 1), 'INVALID_PAGE');
    },

    testContextLogLoadRecordPages() {
        const storage = installFakeHost();
        assert.equal(writeRecordPage(SID, buildRecordPage(1, [summaryRecord('r1', 1, 2), editRecord('r2', 2)])), 'written');
        assert.equal(writeRecordPage(SID, buildRecordPage(2, [summaryRecord('r3', 3, 4)])), 'written');
        const all = loadRecordPages(SID, { recFloor: 1, nextRecPageNo: 3 });
        assert.equal(all.pages.length, 2);
        assert.deepEqual(all.entries.map(entry => entry.id), ['r1', 'r2', 'r3']);
        assert.deepEqual(all.missingPageNos, []);
        assert.equal(all.nextRecPageNo, 3);
        assert.equal(all.stoppedBy, 'end');

        // 区间内缺页（模拟清理）：记录但不中断，后续页仍加载
        storage.map.delete(recordPageKey(SID, 1));
        const withHole = loadRecordPages(SID, { recFloor: 1, nextRecPageNo: 3 });
        assert.deepEqual(withHole.missingPageNos, [1]);
        assert.deepEqual(withHole.entries.map(entry => entry.id), ['r3']);
        assert.equal(withHole.stoppedBy, 'end');

        // 单次扫描上限：返回 continuation 页号
        const limited = loadRecordPages(SID, { recFloor: 1, nextRecPageNo: 3 }, { maxPages: 1 });
        assert.deepEqual(limited.missingPageNos, [1]);
        assert.equal(limited.nextRecPageNo, 2);
        assert.equal(limited.stoppedBy, 'limit');
    },

    testContextLogMissingKeyClassifier() {
        assert.equal(isMissingKeyError(new Error('key not found（海豹：key 不存在时抛异常）')), true);
        assert.equal(isMissingKeyError({ code: 'NOT_FOUND', message: 'x' }), true);
        assert.equal(isMissingKeyError(new Error('storage backend read failed: disk I/O error')), false);
        assert.equal(isMissingKeyError({ code: 'EIO', message: 'input/output error' }), false);
    },

    testContextLogMissingKeyDetectorOverride() {
        const storage = installFakeHost();
        storage.getErrorOverride = new Error('KABOOM：未知的存储异常');
        // 默认启发式不认这条异常 → 按读失败抛
        expectPageError(() => readEventPage(SID, 1), 'READ_FAILED');
        // 装配期安装精确判定后，同一异常应视为缺失
        setMissingKeyErrorDetector(error => error instanceof Error && error.message.startsWith('KABOOM'));
        try {
            assert.equal(readEventPage(SID, 1), null);
        } finally {
            setMissingKeyErrorDetector(null);
        }
        // 恢复默认：再次按读失败处理
        expectPageError(() => readEventPage(SID, 1), 'READ_FAILED');
    },
};
