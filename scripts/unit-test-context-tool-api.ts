// read_raw / grep_raw 工具适配单测：参数归一、格式化、分页游标、指针、无命中。
import assert from 'node:assert/strict';

import { formatGrepRawResult, formatReadCursor, grepRawForTool, parseReadCursor, readRawForTool } from '../src/context/tool_api';
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

async function seed(sid: string, count = 12): Promise<ContextService> {
    storage = new FakeStorage();
    installHost();
    const service = await ContextService.open(sid);
    for (let i = 1; i <= count; i++) {
        service.appendUser('QQ:1', `m${i}`, [{ type: 'text', text: i % 3 === 0 ? `needle-${i}` : `普通-${i}` }]);
    }
    assert.equal((await service.flush()).ok, true);
    return service;
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextToolApiCursor() {
        assert.equal(formatReadCursor(null), '');
        assert.deepEqual(parseReadCursor('5:12'), { seq: 5, offset: 12 });
        assert.equal(parseReadCursor('bad'), null);
        assert.equal(parseReadCursor(''), null);
    },

    async testContextToolApiReadSingleAndRange() {
        const service = await seed('QQ:tool-read');
        const single = readRawForTool(service, { id: 'e:1' });
        assert.ok(single.includes('e:1'));
        assert.ok(single.includes('普通-1'));
        const range = readRawForTool(service, { id: 'e:1-3', limit: 2, max_chars: 1000 });
        assert.ok(range.includes('普通-1'));
        assert.ok(range.includes('普通-2'));
        assert.ok(range.includes('[cursor='), '未读完应有游标');
        const cursor = /\[cursor=([^\]]+)\]/.exec(range)?.[1];
        assert.ok(cursor);
        const next = readRawForTool(service, { id: 'e:1-3', limit: 2, max_chars: 1000, cursor });
        assert.ok(next.includes('needle-3'));
        assert.ok(next.includes('[已读完]'));
    },

    async testContextToolApiReadMissingId() {
        const service = await seed('QQ:tool-no-id');
        assert.throws(() => readRawForTool(service, {}), /缺少 id/);
        assert.throws(() => grepRawForTool(service, {}), /缺少 pattern/);
    },

    async testContextToolApiGrep() {
        const service = await seed('QQ:tool-grep', 12);
        const result = grepRawForTool(service, { pattern: 'needle' });
        assert.ok(result.includes('命中 4 条'));
        assert.ok(result.includes('e:3'));
        assert.ok(result.includes('read_raw id=e:3') || result.includes('→ e:3'));
        const none = grepRawForTool(service, { pattern: '不存在' });
        assert.ok(none.includes('命中 0 条'));
        assert.ok(none.includes('无命中'));
        const regex = grepRawForTool(service, { pattern: '^needle-\\d+$', regex: true });
        assert.ok(regex.includes('命中'));
    },

    testContextToolApiFormatEmptyGrep() {
        const text = formatGrepRawResult('x', { hits: [], nextCursor: null, exhausted: true, scannedPages: 1, skippedPages: [] });
        assert.ok(text.includes('命中 0 条'));
        assert.ok(text.includes('已扫描完'));
    },
};
