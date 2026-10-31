// M1 单测：规则库与进度分片（trigger/store）。
// 用内存 host 隔离存储；注入 now 验证写节流。
import assert from 'node:assert/strict';

import { getHost, setHost } from '../src/core/host';
import { hashRuleId, STATE_WRITE_MIN_INTERVAL_MS, TriggerRuleStore } from '../src/trigger/store';
import { validateRule } from '../src/trigger/rule';
import type { TriggerRule } from '../src/trigger/types';

class MemoryStorage {
    map = new Map<string, string>();
    get(key: string): string | null {
        return this.map.has(key) ? this.map.get(key)! : null;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

function installMemoryHost(): MemoryStorage {
    const storage = new MemoryStorage();
    setHost({
        storage,
        clock: { now: () => Date.now() },
        fetch: (() => Promise.reject(new Error('no fetch'))) as never,
        ext: {} as never,
    });
    return storage;
}

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

function rule(id: string, extra: Record<string, unknown> = {}): TriggerRule {
    const result = validateRule({
        id,
        enabled: true,
        source: 'ai',
        createdAt: NOW,
        wake_prompts: ['醒醒'],
        gates: [{ type: 'regex', pattern: '考试' }],
        scope: {},
        limits: { max_triggers: -1, expire_at: 0 },
        ...extra,
    }, { scope: {}, now: NOW });
    assert.equal(result.ok, true, `rule ${id} should be valid`);
    return (result as { ok: true; rule: TriggerRule }).rule;
}

export const tests = {
    testHashRuleIdStable(): void {
        assert.equal(hashRuleId('tr_abc'), hashRuleId('tr_abc'));
        assert.notEqual(hashRuleId('tr_abc'), hashRuleId('tr_abd'));
        assert.ok(/^[0-9a-z]+$/.test(hashRuleId('tr_abc')));
    },

    testStoreLoadIsolatesBadEntries(): void {
        const storage = installMemoryHost();
        storage.set('aitrig:rules', JSON.stringify({
            version: 1,
            rules: [
                { id: 'ok1', gates: [{ type: 'regex', pattern: 'x' }], wake_prompts: ['p'] },
                { id: 'bad1', gates: [] },
            ],
        }));
        const store = new TriggerRuleStore({ now: () => NOW });
        const rules = store.load();
        assert.equal(rules.length, 1);
        assert.equal(rules[0].id, 'ok1');
        const bad = store.getBad();
        assert.equal(bad.length, 1);
        assert.ok(bad[0].errors.length > 0);
        assert.ok(storage.get('aitrig:rules:bad'));
    },

    testStoreUpsertRemoveAndBackup(): void {
        const storage = installMemoryHost();
        const store = new TriggerRuleStore({ now: () => NOW });
        store.load();
        store.upsert(rule('r1'));
        store.upsert(rule('r2'));
        assert.equal(store.list().length, 2);
        assert.ok(storage.get('aitrig:rules'));
        // 覆盖写前备份单键存在
        assert.ok(storage.get('aitrig:rules:bak'));
        store.upsert(rule('r1', { wake_prompts: ['改过'] }));
        assert.equal(store.getById('r1')!.wake_prompts[0], '改过');
        assert.equal(store.remove('r2'), true);
        assert.equal(store.remove('nope'), false);
        assert.equal(store.list().length, 1);
    },

    testStoreStateWriteThrottle(): void {
        installMemoryHost();
        let now = NOW;
        const store = new TriggerRuleStore({ now: () => now });
        const state = { 'QQ-Group:1': { fired: 1, lastFiredAt: now } };
        assert.equal(store.writeState('r1', state), true);
        now += 1000;
        assert.equal(store.writeState('r1', { ...state, 'QQ-Group:1': { fired: 2, lastFiredAt: now } }), false);
        now += STATE_WRITE_MIN_INTERVAL_MS;
        assert.equal(store.writeState('r1', { ...state, 'QQ-Group:1': { fired: 3, lastFiredAt: now } }), true);
        assert.equal(store.readState('r1')['QQ-Group:1'].fired, 3);
        assert.equal(store.readSessionState('r1', 'QQ-Group:1')!.fired, 3);
        assert.equal(store.writeState('r1', { ...state }, true), true);
    },

    testStorePruneState(): void {
        installMemoryHost();
        const store = new TriggerRuleStore({ now: () => NOW });
        store.writeState('r1', {
            'QQ-Group:1': { fired: 1, lastFiredAt: NOW },
            'QQ-Group:2': { fired: 2, lastFiredAt: NOW },
        }, true);
        const alive = new Set(['QQ-Group:1']);
        assert.equal(store.pruneState('r1', alive), true);
        assert.deepEqual(Object.keys(store.readState('r1')), ['QQ-Group:1']);
        assert.equal(store.pruneState('r1', alive), false);
    },

    testStoreRemoveClearsState(): void {
        const storage = installMemoryHost();
        const store = new TriggerRuleStore({ now: () => NOW });
        store.upsert(rule('r1'));
        store.writeState('r1', { 'QQ-Group:1': { fired: 1, lastFiredAt: NOW } }, true);
        assert.ok(storage.get(`aitrig:state:${hashRuleId('r1')}`));
        store.remove('r1');
        assert.equal(Object.keys(store.readState('r1')).length, 0);
    },

    testStoreRecoversFromBackup(): void {
        const storage = installMemoryHost();
        storage.set('aitrig:rules', '{not-json');
        storage.set('aitrig:rules:bak', JSON.stringify({ version: 1, rules: [rule('from-bak')] }));
        const store = new TriggerRuleStore({ now: () => NOW });
        const rules = store.load();
        assert.equal(rules.length, 1);
        assert.equal(rules[0].id, 'from-bak');
    },

    testStorePreservesBadRulesOnSave(): void {
        const storage = installMemoryHost();
        storage.set('aitrig:rules', JSON.stringify({
            version: 1,
            rules: [
                { id: 'ok1', gates: [{ type: 'regex', pattern: 'x' }], wake_prompts: ['p'] },
                { id: 'bad1', gates: [] },
            ],
        }));
        const store = new TriggerRuleStore({ now: () => NOW });
        assert.equal(store.load().length, 1);
        store.upsert(rule('ok2'));
        const saved = JSON.parse(storage.get('aitrig:rules') || '{}');
        const ids = (saved.rules || []).map((item: { id?: string }) => item.id);
        assert.ok(ids.includes('ok1'));
        assert.ok(ids.includes('ok2'));
        assert.ok(ids.includes('bad1'), '校验失败条目不能被下一次正常写入静默删除');
        // 重新加载后仍能识别坏条目（不会被当成有效规则）
        const reloaded = new TriggerRuleStore({ now: () => NOW });
        assert.equal(reloaded.load().length, 2);
        assert.equal(reloaded.getBad().length, 1);
    },

    testStoreCountByScope(): void {
        installMemoryHost();
        const store = new TriggerRuleStore({ now: () => NOW });
        store.load();
        store.upsert(rule('g1'));
        store.upsert(rule('s1', { scope: { sessions: ['QQ-Group:1'] }, gates: [{ type: 'regex', pattern: 'y' }] }));
        assert.equal(store.count('global'), 1);
        assert.equal(store.count('session'), 1);
        assert.ok(getHost());
    },
};
