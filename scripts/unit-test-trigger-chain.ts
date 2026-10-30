// M2 单测：链规则编排（trigger_rule）——不触模型的路径：无命中/认领/门失败/delay 挂起。
// fired 路径依赖模型与提示词装配，由启动回归与集成测试覆盖。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { setHost } from '../src/core/host';
import { claimTable, messageClaimKey } from '../src/pipeline/claim_table';
import { getPendingDelays, getRuleStore, resetTriggerRuleStateForTest, runChain } from '../src/pipeline/trigger_rule';
import { validateRule } from '../src/trigger/rule';
import { Session } from '../src/session/session';
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

setHost({
    storage: new MemoryStorage(),
    clock: { now: () => Date.now() },
    fetch: (() => Promise.reject(new Error('no fetch'))) as never,
    ext: {} as never,
});
(Config as unknown as { trigger: unknown }).trigger = { BUCKET_LIMIT: 3, FILL_INTERVAL: 3600, EVENT_TRIGGER: { CONFIG: { rules: [] } } };
(Config as unknown as { tool: unknown }).tool = { BLOCKED: [] };
(Config as unknown as { base: unknown }).base = { GLOBAL_STANDBY: false };

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

function makeSession(sid = 'QQ-Group:1'): Session {
    const session = new Session();
    session.sessionId = sid;
    session.setting.aiEnabled = true;
    session.bucket.count = 0;
    session.bucket.lastTime = NOW;
    return session;
}

function makeCtx(sid = 'QQ-Group:1'): seal.MsgContext {
    return {
        endPoint: { userId: 'QQ:10000', platform: 'QQ' },
        player: { userId: 'QQ:20000' },
        group: { groupId: sid },
        isPrivate: false,
    } as unknown as seal.MsgContext;
}

function makeMsg(rawId = 1): seal.Message {
    return { rawId } as unknown as seal.Message;
}

function seedRule(raw: Record<string, unknown>): TriggerRule {
    const result = validateRule({
        id: 'tr_test',
        enabled: true,
        source: 'ai',
        createdAt: NOW,
        wake_prompts: ['醒醒'],
        gates: [{ type: 'regex', pattern: '考试' }],
        scope: {},
        limits: { max_triggers: -1, expire_at: 0 },
        ...raw,
    }, { scope: {}, now: NOW });
    assert.equal(result.ok, true, `seed rule invalid: ${JSON.stringify((result as { ok: false; errors: string[] }).errors)}`);
    const rule = (result as { ok: true; rule: TriggerRule }).rule;
    getRuleStore().upsert(rule);
    return rule;
}

export const tests = {
    async testChainNoMatch(): Promise<void> {
        resetTriggerRuleStateForTest();
        claimTable.clearAll();
        seedRule({ gates: [{ type: 'regex', pattern: '考试' }] });
        const session = makeSession('QQ-Group:10');
        const result = await runChain({ session, ctx: makeCtx('QQ-Group:10'), msg: makeMsg(1), text: '今天天气不错', now: NOW });
        assert.equal(result.status, 'no-match');
    },

    async testChainCounterThenDelaySuspends(): Promise<void> {
        resetTriggerRuleStateForTest();
        claimTable.clearAll();
        seedRule({ gates: [{ type: 'regex', pattern: '考试' }, { type: 'counter', n: 2 }, { type: 'delay', delay_sec: 60 }] });
        const session = makeSession('QQ-Group:11');
        const ctx = makeCtx('QQ-Group:11');
        const first = await runChain({ session, ctx, msg: makeMsg(1), text: '考试啦', now: NOW });
        // 第一次 counter 未达阈值：整链失败（计数已落盘，未起轮）
        assert.equal(first.status, 'no-match');
        assert.equal(getPendingDelays().size, 0);
        const st = getRuleStore().readState('tr_test')['QQ-Group:11'];
        assert.equal(st?.fired || 0, 0);
        assert.equal(st?.gates?.['1']?.count, 1);
        // 第二次同规则：counter 达标归零，然后 delay 再次挂起
        const second = await runChain({ session, ctx, msg: makeMsg(2), text: '再考试', now: NOW });
        assert.equal(second.status, 'suspended');
        const st2 = getRuleStore().readState('tr_test')['QQ-Group:11'];
        assert.equal(st2?.gates?.['1']?.count ?? 0, 0);
        getPendingDelays().clear();
    },

    async testChainClaimBlocksSecond(): Promise<void> {
        resetTriggerRuleStateForTest();
        claimTable.clearAll();
        seedRule({ gates: [{ type: 'regex', pattern: '考试' }] });
        const session = makeSession('QQ-Group:12');
        const ctx = makeCtx('QQ-Group:12');
        // 先手工认领（模拟已由判定/其他入口处理）
        claimTable.claim('QQ-Group:12', messageClaimKey('QQ-Group:12', 5), 'mode');
        const result = await runChain({ session, ctx, msg: makeMsg(5), text: '考试', claimIdentity: 5, now: NOW });
        assert.equal(result.status, 'claimed');
    },

    async testChainSkipsTimerSourceOnMessagePath(): Promise<void> {
        resetTriggerRuleStateForTest();
        claimTable.clearAll();
        seedRule({
            scope: { sessions: ['QQ-Group:13'] },
            gates: [{ type: 'timer', types: 'interval', hours: 12, count: -1, prompts: ['提醒'] }],
            wake_prompts: [],
        });
        const session = makeSession('QQ-Group:13');
        const result = await runChain({ session, ctx: makeCtx('QQ-Group:13'), msg: makeMsg(1), text: '任意', now: NOW });
        assert.equal(result.status, 'no-match');
    },
};
