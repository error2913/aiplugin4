// Context v2 迁移持久化单测：写页 → head → store 可加载；幂等/强制重跑。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import { ContextStore } from '../src/context/store';
import { headKey } from '../src/context/keys';
import { migrateLegacySession, isMigrated } from '../src/context/migrate/persist';
import { parseHead } from '../src/context/head';
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
        fetch: (() => { throw new Error('no fetch in unit test'); }) as any,
        ext: {} as any,
    });
}

function resetHost(): void {
    storage = new FakeStorage();
    installHost();
}

function legacyContext() {
    return {
        archiveSeq: 2,
        rawSeq: 3,
        settledSeq: 1,
        messages: [
            {
                role: 'user',
                contentItems: [
                    { userId: 'QQ:1', messageId: 'm1', time: 10, text: '带标签 [at:123] 的文字' },
                    { systemName: 'group-event', eventType: 'group_recall', raw: { x: 1 }, time: 11, text: '撤回' },
                ],
            },
            { role: 'assistant', contentItems: [{ text: '收到', time: 12, messageId: 'a1' }] },
        ],
    };
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextV2MigratePersistWritesLoadableStore() {
        resetHost();
        const sid = 'QQ-Group:migrate';
        assert.equal(isMigrated(sid), false);
        const result = migrateLegacySession(sid, legacyContext(), {
            parseText: (text, mode) => {
                // 简单模拟 content 解析：标签转 mention
                if (mode === 'user') {
                    const m = /^(.*)\[at:(\d+)\](.*)$/.exec(text);
                    if (m) return [
                        { type: 'text', text: m[1] },
                        { type: 'mention', id: m[2] },
                        { type: 'text', text: m[3] },
                    ];
                }
                return [{ type: 'text', text }];
            },
        });
        assert.equal(result.migrated, true);
        assert.equal(result.events, 3);
        assert.equal(isMigrated(sid), true);
        const head = parseHead(storage.map.get(headKey(sid))!);
        assert.ok(head);
        assert.equal(head!.nextSeq, 4);
        assert.equal(head!.nextPageNo, 2);
        assert.equal(head!.legacy?.rawSeq, 3);

        const store = await ContextStore.open(sid);
        const events = store.snapshot().events;
        assert.equal(events.length, 3);
        const firstUser = events[0] as any;
        assert.ok(Array.isArray(firstUser.parts));
        assert.ok(firstUser.parts.some((p: any) => p.type === 'mention' && p.id === '123'));
        assert.equal(store.snapshot().records.length, 0);
    },

    async testContextV2MigratePersistIdempotent() {
        resetHost();
        const sid = 'QQ-Group:migrate-idem';
        const first = migrateLegacySession(sid, legacyContext());
        assert.equal(first.migrated, true);
        const second = migrateLegacySession(sid, legacyContext());
        assert.equal(second.migrated, false);
        assert.equal(second.events, 0);
        const store = await ContextStore.open(sid);
        assert.equal(store.snapshot().events.length, 3);
    },

    async testContextV2MigratePersistForceRewritesWithoutDuplicating() {
        resetHost();
        const sid = 'QQ-Group:migrate-force';
        migrateLegacySession(sid, legacyContext());
        const forced = migrateLegacySession(sid, legacyContext(), { force: true });
        assert.equal(forced.migrated, true);
        const store = await ContextStore.open(sid);
        assert.equal(store.snapshot().events.length, 3, '强制重跑不应重复事件');
        assert.equal(store.getHead().nextSeq, 4);
    },

    async testContextV2MigratePersistEmptyLegacy() {
        resetHost();
        const sid = 'QQ-Group:migrate-empty';
        const result = migrateLegacySession(sid, {});
        assert.equal(result.migrated, true);
        assert.equal(result.events, 0);
        const store = await ContextStore.open(sid);
        assert.equal(store.snapshot().events.length, 0);
        assert.equal(store.getHead().nextSeq, 1);
    },
};
