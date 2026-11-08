// M2 单测：链规则编排（trigger_rule）——不触模型的路径：无命中/认领/门失败/delay 挂起。
// fired 路径依赖模型与提示词装配，由启动回归与集成测试覆盖。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { setAgentResolver } from '../src/core/ports/agent_registry';
import { setTriggerTimerHandler } from '../src/core/ports/trigger_timer';
import { setHost } from '../src/core/host';
import { claimTable, messageClaimKey } from '../src/pipeline/claim_table';
import { getPendingDelays, getRuleStore, resetTriggerRuleStateForTest, runChain } from '../src/pipeline/trigger_rule';
import { ensureRuleTimersForSession, fireRuleTimer, installTriggerTimerHandler, resetTriggerTimerHandlerForTest } from '../src/pipeline/trigger_timer_impl';
import { wakeSession } from '../src/pipeline/wake';
import { QuotaManager } from '../src/quota/manager';
import { resetStoreCacheForTest } from '../src/quota/store';
import { validateRule } from '../src/trigger/rule';
import { Session } from '../src/session/session';
import { Setting } from '../src/session/setting';
import { TimerInfo, TimerManager } from '../src/timer';
import { revive } from '../src/utils/revive';
import { activeSubSegmentOccurrence, nextActiveTimeStart, parseActiveTimeGate } from '../src/utils/time_window';
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

const storage = new MemoryStorage();
const storeMap = storage.map;

setHost({
    storage: {
        get: (key: string) => storage.get(key),
        set: (key: string, value: string) => storage.set(key, value),
    },
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

    /** 规则定时器：未到点不得分派（回归：5 秒轮询曾把 interval 当每轮执行，30 分钟规则每 5 秒点火） */
    async testRuleTimerNotFiredBeforeDue(): Promise<void> {
        let fired = 0;
        setTriggerTimerHandler({ owns: () => true, fire: async () => { fired++; } });
        const now = Math.floor(Date.now() / 1000);
        const timer = new TimerInfo();
        timer.sid = 'QQ-Group:20';
        timer.isPrivate = false;
        timer.epId = 'QQ:10000';
        timer.ruleId = 'tr_due_test';
        timer.modeTag = 'rule';
        timer.type = 'interval';
        timer.set = now;
        timer.interval = 1800;
        timer.target = now + 1800;
        timer.count = 24;
        timer.prompts = ['提醒'];
        TimerManager.timerQueue = [timer];
        try {
            await TimerManager.task();
            assert.equal(fired, 0, '未到点的规则定时器不应分派');
            assert.equal(TimerManager.timerQueue.includes(timer), true, '未到点条目应保留在队列');

            // 到点（含进程离线后过点）后应分派一次
            timer.set = now - 2000;
            timer.target = now - 200;
            await TimerManager.task();
            assert.equal(fired, 1, '到点后应分派一次');
        } finally {
            resetTriggerTimerHandlerForTest();
            installTriggerTimerHandler();
            TimerManager.timerQueue = [];
        }
    },

    /** 规则定时器：规则已删的幽灵条目应就地清理，而不是每轮刷告警 */
    async testRuleTimerGhostRemoved(): Promise<void> {
        setTriggerTimerHandler({ owns: () => false, fire: async () => { throw new Error('失效条目不应分派'); } });
        const now = Math.floor(Date.now() / 1000);
        const timer = new TimerInfo();
        timer.sid = 'QQ-Group:21';
        timer.isPrivate = false;
        timer.epId = 'QQ:10000';
        timer.ruleId = 'tr_missing';
        timer.modeTag = 'rule';
        timer.type = 'interval';
        timer.set = now;
        timer.interval = 1800;
        timer.target = now + 1800;
        timer.count = 24;
        TimerManager.timerQueue = [timer];
        try {
            await TimerManager.task();
            assert.equal(TimerManager.timerQueue.includes(timer), false, '规则已删的幽灵条目应就地清理');
            assert.equal(TimerManager.listRuleTimers('tr_missing').length, 0);
        } finally {
            resetTriggerTimerHandlerForTest();
            installTriggerTimerHandler();
            TimerManager.timerQueue = [];
        }
    },

    /** 规则定时器：fire 期间规则被删，续期不得复活定时器（回归：删除后仍每 5 秒点火/刷告警） */
    async testDeletedRuleTimerNotRearmed(): Promise<void> {
        const g = globalThis as any;
        const origGetEndPoints = g.seal.getEndPoints;
        const origCreateTempCtx = g.seal.createTempCtx;
        const sid = 'QQ-Group:22';
        g.seal.getEndPoints = () => [{ userId: 'QQ:10000', platform: 'QQ', state: 1 }];
        g.seal.createTempCtx = (ep: any, msg: any) => ({
            endPoint: { userId: ep.userId },
            player: { userId: 'QQ:20000', name: '测试员' },
            isPrivate: msg?.messageType === 'private',
            group: msg?.groupId ? { groupId: msg.groupId } : null,
        });
        setAgentResolver(() => ({ sessionService: { getSession: () => ({ sessionId: sid, lastMsgRef: {} }) } }) as any);
        resetTriggerRuleStateForTest();
        const now = Math.floor(Date.now() / 1000);
        const timer = new TimerInfo();
        timer.sid = sid;
        timer.isPrivate = false;
        timer.epId = 'QQ:10000';
        timer.ruleId = 'tr_deleted';
        timer.modeTag = 'rule';
        timer.type = 'interval';
        timer.set = now - 10;
        timer.interval = 1800;
        timer.target = now + 1790;
        timer.count = 24;
        TimerManager.timerQueue = [timer];
        try {
            await fireRuleTimer(timer);
            assert.equal(TimerManager.listRuleTimers('tr_deleted').length, 0, '规则已删时续期不应复活定时器');
        } finally {
            g.seal.getEndPoints = origGetEndPoints;
            g.seal.createTempCtx = origCreateTempCtx;
            setAgentResolver(null);
            TimerManager.timerQueue = [];
        }
    },

    /** 旧存档 standby=true 迁移：revive 会丢弃 standby，必须在 revive 前保存原始 setting 再迁移 */
    testLegacyStandbyMigration(): void {
        const legacy = { priv: 0, standby: true, counter: -1, timer: -1, prob: -1, regexTrigger: true, eventTrigger: true, judge: false, activeTimeInfo: { start: 0, end: 0, segs: 0 }, overrides: {} };
        const revived = revive(Setting, legacy as never);
        assert.equal((revived as unknown as { standby?: unknown }).standby, undefined);
        assert.equal(revived.aiEnabled, false);
        Setting.applyLegacyStandby(legacy, revived);
        assert.equal(revived.aiEnabled, true, '旧存档 standby=true 必须迁移为 aiEnabled=true');
        // 旧存档 standby=false（AI 关闭）不得迁移成开启
        const off = { ...legacy, standby: false };
        const revivedOff = revive(Setting, off as never);
        Setting.applyLegacyStandby(off, revivedOff);
        assert.equal(revivedOff.aiEnabled, false);
    },

    /** wake 先判闸：aiEnabled=false 时不写提示、不起轮 */
    async testWakeGatedSkipsPrompt(): Promise<void> {
        let prompt = 0;
        let chat = 0;
        const session = {
            setting: { enabled: () => false },
            hasBucketToken: () => true,
            context: { addSystemUserMessage: async () => { prompt++; } },
            save: () => undefined,
            chat: async () => { chat++; return 'fired' as const; },
        };
        const outcome = await wakeSession(session as never, {} as never, {} as never, { kind: 'rule', wakeText: '提醒' });
        assert.equal(outcome, 'gated');
        assert.equal(prompt, 0, 'gated 时不应写触发提示');
        assert.equal(chat, 0);
    },

    /** wake 先判桶：桶空时不写提示、不起轮（避免无法兑现的提示污染上下文） */
    async testWakeBucketEmptySkipsPrompt(): Promise<void> {
        let prompt = 0;
        let chat = 0;
        const session = {
            setting: { enabled: () => true },
            hasBucketToken: () => false,
            context: { addSystemUserMessage: async () => { prompt++; } },
            save: () => undefined,
            chat: async () => { chat++; return 'fired' as const; },
        };
        const outcome = await wakeSession(session as never, {} as never, {} as never, { kind: 'rule', wakeText: '提醒' });
        assert.equal(outcome, 'bucket-empty');
        assert.equal(prompt, 0);
        assert.equal(chat, 0);
    },

    /** 手动定时器视图/删除必须排除规则/模式条目（否则 .ai trg timer clr / cancel_timer 会误删规则定时器） */
    testManualTimersIsolated(): void {
        const sid = 'QQ-Group:30';
        const manual = new TimerInfo();
        manual.sid = sid;
        manual.isPrivate = false;
        manual.epId = 'QQ:10000';
        manual.type = 'target';
        manual.target = 1234567890;
        const ruleTimer = new TimerInfo();
        ruleTimer.sid = sid;
        ruleTimer.isPrivate = false;
        ruleTimer.epId = 'QQ:10000';
        ruleTimer.ruleId = 'tr_keep';
        ruleTimer.type = 'interval';
        ruleTimer.interval = 1800;
        ruleTimer.target = Math.floor(Date.now() / 1000) + 1800;
        ruleTimer.count = 3;
        TimerManager.timerQueue = [manual, ruleTimer];
        try {
            assert.deepEqual(TimerManager.getManualTimers(sid), [manual]);
            assert.equal(TimerManager.removeTimerEntries(TimerManager.getManualTimers(sid), [1]), 1);
            assert.equal(TimerManager.timerQueue.includes(ruleTimer), true, '规则条目不能被手动定时器接口删除');
            assert.equal(TimerManager.clearManualTimers(sid), 0);
        } finally {
            TimerManager.timerQueue = [];
        }
    },

    /** 多 [[timer]] 共用 ruleId 时精确删单条，不能把同 ruleId 的其它计划一起删掉 */
    testRuleTimerEntryPreciseRemoval(): void {
        const sid = 'QQ-Group:31';
        const now = Math.floor(Date.now() / 1000);
        const mk = (target: number): TimerInfo => {
            const timer = new TimerInfo();
            timer.sid = sid;
            timer.isPrivate = false;
            timer.epId = 'QQ:10000';
            timer.ruleId = 'mode:' + sid;
            timer.type = 'target';
            timer.target = target;
            return timer;
        };
        const first = mk(now + 100);
        const second = mk(now + 200);
        TimerManager.timerQueue = [first, second];
        try {
            assert.equal(TimerManager.removeRuleTimerEntry(first), true);
            assert.deepEqual(TimerManager.listRuleTimers('mode:' + sid), [second]);
        } finally {
            TimerManager.timerQueue = [];
        }
    },

    /** 规则 timer 补注册：命中本会话的 timer 源规则，幂等（重复调用不重复添加） */
    testEnsureRuleTimersIdempotent(): void {
        resetTriggerRuleStateForTest();
        TimerManager.timerQueue = [];
        const sid = 'QQ-Group:32';
        seedRule({
            scope: { sessions: [sid] },
            gates: [{ type: 'timer', types: 'interval', hours: 12, count: -1, prompts: ['提醒'] }],
            wake_prompts: [],
        });
        const origIntervalId = TimerManager.intervalId;
        TimerManager.intervalId = 1;
        try {
            assert.equal(ensureRuleTimersForSession({ sid, isPrivate: false, epId: 'QQ:10000' }), 1);
            assert.equal(ensureRuleTimersForSession({ sid, isPrivate: false, epId: 'QQ:10000' }), 0);
            assert.equal(TimerManager.listRuleTimers('tr_test').length, 1);
        } finally {
            TimerManager.intervalId = origIntervalId;
            TimerManager.timerQueue = [];
            resetTriggerRuleStateForTest();
        }
    },

    /** active_time 源门：解析/下一子段/段 occurrence（每段最多 1 次的去重键） */
    testActiveTimeGateHelpers(): void {
        const now = new Date(2026, 9, 31, 10, 30, 0).getTime();
        const segment = parseActiveTimeGate({ start: '10:00', end: '20:00', segs: 5 });
        assert.ok(segment);
        assert.equal(segment!.segs, 5);
        const next = nextActiveTimeStart(segment!, now);
        assert.ok(next * 1000 > now, '下一子段开始必须晚于当前时间');
        const first = activeSubSegmentOccurrence(segment!, now);
        assert.ok(first >= 0);
        const later = new Date(2026, 9, 31, 12, 10, 0).getTime();
        assert.notEqual(activeSubSegmentOccurrence(segment!, later), first, '不同子段 occurrence 必须不同');
        assert.equal(parseActiveTimeGate({ start: '10:00', end: '10:00' }), null, '起止相同必须判非法');
    },

    /** active_time 源门规则：ensure 补注册一条到点定时器，且幂等 */
    testEnsureRegistersActiveTimeRule(): void {
        resetTriggerRuleStateForTest();
        TimerManager.timerQueue = [];
        const sid = 'QQ-Group:34';
        seedRule({
            scope: { sessions: [sid] },
            gates: [{ type: 'active_time', start: '10:00', end: '20:00', segs: 2 }],
            wake_prompts: ['醒醒'],
        });
        const origIntervalId = TimerManager.intervalId;
        TimerManager.intervalId = 1;
        try {
            assert.equal(ensureRuleTimersForSession({ sid, isPrivate: false, epId: 'QQ:10000' }), 1);
            const timers = TimerManager.listRuleTimers('tr_test');
            assert.equal(timers.length, 1);
            assert.ok(timers[0].target > Math.floor(Date.now() / 1000));
            assert.equal(ensureRuleTimersForSession({ sid, isPrivate: false, epId: 'QQ:10000' }), 0, '已有条目时不得重复注册');
        } finally {
            TimerManager.intervalId = origIntervalId;
            TimerManager.timerQueue = [];
            resetTriggerRuleStateForTest();
        }
    },

    /** 忙时链规则只求值不起轮：返回 parked + wakeText，由消息入口挂起 */
    async testChainDeferWakeParks(): Promise<void> {
        resetTriggerRuleStateForTest();
        claimTable.clearAll();
        seedRule({ gates: [{ type: 'regex', pattern: '考试' }], wake_prompts: ['醒醒'] });
        const session = makeSession('QQ-Group:33');
        const result = await runChain({
            session,
            ctx: makeCtx('QQ-Group:33'),
            msg: makeMsg(1),
            text: '考试啦',
            now: NOW,
            deferWake: true,
        });
        assert.equal(result.status, 'parked');
        assert.equal(result.wakeText, '醒醒');
    },

    /** C1：quota 结果终止链（不再匹配后续规则），且不记 fired */
    async testChainQuotaOutcomeStopsChain(): Promise<void> {
        resetTriggerRuleStateForTest();
        claimTable.clearAll();
        seedRule({ scope: { sessions: ['QQ-Group:40'] }, gates: [{ type: 'regex', pattern: '考试' }], wake_prompts: ['醒醒'] });
        seedRule({ id: 'tr_second', scope: { sessions: ['QQ-Group:40'] }, gates: [{ type: 'regex', pattern: '考试' }], wake_prompts: ['醒醒'] });
        // 假会话：起轮一律返回 quota（模拟细闸/粗闸拒绝）
        const session = {
            sessionId: 'QQ-Group:40',
            setting: { enabled: () => true },
            hasBucketToken: () => true,
            context: { addSystemUserMessage: async () => undefined },
            save: () => undefined,
            chat: async () => 'quota' as const,
        };
        try {
            const result = await runChain({
                session: session as never,
                ctx: makeCtx('QQ-Group:40'),
                msg: makeMsg(1),
                text: '考试啦',
                now: NOW,
            });
            assert.equal(result.status, 'quota', 'quota 必须原样上抛给调用方');
            const state = getRuleStore().readState('tr_test')['QQ-Group:40'];
            assert.equal(state?.fired || 0, 0, 'quota 不得记 fired');
            const second = getRuleStore().readState('tr_second')['QQ-Group:40'];
            assert.equal(second, undefined, 'quota 必须终止链，不得继续匹配后续规则');
        } finally {
            resetTriggerRuleStateForTest();
        }
    },

    /**
     * C1：规则定时器遇 quota 不消费次数
     * （`advanceTimer(timer, outcome === 'fired')` ⇒ interval 按原 count 重排、target 不补）
     */
    async testAdvanceTimerQuotaNotConsumed(): Promise<void> {
        const g = globalThis as any;
        const origGetEndPoints = g.seal.getEndPoints;
        const origCreateTempCtx = g.seal.createTempCtx;
        const sid = 'QQ-Group:41';
        g.seal.getEndPoints = () => [{ userId: 'QQ:10000', platform: 'QQ', state: 1 }];
        g.seal.createTempCtx = (ep: any, msg: any) => ({
            endPoint: { userId: ep.userId },
            player: { userId: 'QQ:20000' },
            isPrivate: msg?.messageType === 'private',
            group: msg?.groupId ? { groupId: msg.groupId } : null,
        });
        setAgentResolver(() => ({
            sessionService: {
                getSession: () => ({
                    sessionId: sid,
                    lastMsgRef: {},
                    setting: { enabled: () => true },
                    hasBucketToken: () => true,
                    context: { addSystemUserMessage: async () => undefined },
                    save: () => undefined,
                    chat: async () => 'quota' as const,
                }),
            },
        }) as any);
        TimerManager.timerQueue = [];
        const timer = new TimerInfo();
        timer.sid = sid;
        timer.isPrivate = false;
        timer.epId = 'QQ:10000';
        timer.ruleId = 'mode:' + sid;
        timer.modeTag = 'mode';
        timer.type = 'interval';
        timer.set = Math.floor(Date.now() / 1000) - 10;
        timer.interval = 1800;
        timer.target = Math.floor(Date.now() / 1000) - 5;
        timer.count = 3;
        timer.prompts = ['提醒'];
        TimerManager.timerQueue = [timer];
        try {
            await fireRuleTimer(timer);
            const left = TimerManager.listRuleTimers('mode:' + sid);
            assert.equal(left.length, 1, 'quota 后 interval 应重排（不消费次数）');
            assert.equal(left[0].count, 3, 'quota 不得把 count 从 3 减到 2');
        } finally {
            g.seal.getEndPoints = origGetEndPoints;
            g.seal.createTempCtx = origCreateTempCtx;
            setAgentResolver(null);
            TimerManager.timerQueue = [];
        }
    },

    /** C2：wake 先判配额——超限时不写触发提示、不起轮 */
    async testWakeNoPromptOnQuota(): Promise<void> {
        setHost({
            storage: {
                get: (key: string) => storeMap.get(key) ?? null,
                set: (key: string, value: string) => { storeMap.set(key, value); },
            },
            clock: { now: () => NOW },
            fetch: (() => Promise.reject(new Error('no fetch'))) as never,
            ext: {} as never,
        });
        resetStoreCacheForTest();
        QuotaManager.releaseAllInflightForTest();
        QuotaManager.clearNotifiedForTest();
        QuotaManager.configure(() => ({
            ENABLED: true,
            LIMIT_5H: 100,
            LIMIT_WEEK: 0,
            LIMIT_MONTH: 0,
            SESSION_PERCENT: 100,
            USER_PERCENT: 100,
            PEAK_RULE: { segments: [], warnings: [] },
            PURPOSE_PERCENT: { summarization: 100, judge: 100, 'image-understanding': 100, 'text-embedding': 100 },
            NOTIFY_ON_LIMIT: false,
        }));
        let prompt = 0;
        let chat = 0;
        const session = {
            sessionId: 'QQ-Group:quota-wake',
            setting: { enabled: () => true },
            hasBucketToken: () => true,
            context: { addSystemUserMessage: async () => { prompt++; } },
            save: () => undefined,
            chat: async () => { chat++; return 'fired' as const; },
        };
        try {
            QuotaManager.record('chat', 200, { sessionId: 'QQ-Group:quota-wake', userId: '' });
            const outcome = await wakeSession(session as never, {} as never, {} as never, { kind: 'rule', wakeText: '提醒' });
            assert.equal(outcome, 'quota');
            assert.equal(prompt, 0, 'quota 时不得写触发提示（否则污染上下文且无法兑现）');
            assert.equal(chat, 0);
        } finally {
            QuotaManager.configure(() => ({
                ENABLED: false,
                LIMIT_5H: 0,
                LIMIT_WEEK: 0,
                LIMIT_MONTH: 0,
                SESSION_PERCENT: 100,
                USER_PERCENT: 100,
                PEAK_RULE: { segments: [], warnings: [] },
                PURPOSE_PERCENT: { summarization: 100, judge: 100, 'image-understanding': 100, 'text-embedding': 100 },
                NOTIFY_ON_LIMIT: false,
            }));
            QuotaManager.reset();
        }
    },
};
