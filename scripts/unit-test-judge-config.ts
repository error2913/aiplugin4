// M3 单测：判定配置 v2（解析/有效性/默认值） + 判定入口调度（去抖/在飞/探针，注入式时钟）。
import assert from 'node:assert/strict';

import { DEFAULT_JUDGE_CONFIG, JUDGE_TOML_DEFAULT, parseJudgeConfig } from '../src/judge/config';
import { DecisionSchedule } from '../src/pipeline/decision_schedule';

function fakeScheduler(): { scheduler: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }; runAll(): void; pending(): number } {
    let seq = 0;
    const timers = new Map<number, () => void>();
    return {
        scheduler: {
            setTimeout: fn => { const id = ++seq; timers.set(id, fn); return id; },
            clearTimeout: handle => { timers.delete(handle as number); },
        },
        runAll: () => {
            for (const [id, fn] of [...timers.entries()]) {
                timers.delete(id);
                fn();
            }
        },
        pending: () => timers.size,
    };
}

export const tests = {
    testJudgeConfigV2DefaultTemplateValid(): void {
        const state = parseJudgeConfig(JUDGE_TOML_DEFAULT);
        assert.equal(state.valid, true, state.errors.join(';'));
        assert.equal(state.config.DECISION.shadow, true);
        assert.equal(state.config.SCORING.speak_threshold, 0.55);
        assert.equal(state.config.WEIGHTS.interruption_risk, -3);
        assert.equal(state.config.MODEL.context_tokens, 1500);
    },

    testJudgeConfigRejectsEmptyAndV1(): void {
        const empty = parseJudgeConfig('');
        assert.equal(empty.valid, false);
        assert.ok(empty.errors[0].includes('未配置'));
        const v1 = parseJudgeConfig('[scoring]\nspeak_threshold = 0.7');
        assert.equal(v1.valid, false, '缺 version=2 应拒绝');
        // 非法值/范围
        const bad = parseJudgeConfig('version = 2\n[decision]\naggressiveness = 9');
        assert.equal(bad.valid, false);
    },

    testJudgeConfigPartialOverride(): void {
        const state = parseJudgeConfig('version = 2\n[energy]\nreply_cost = 8');
        assert.equal(state.valid, true);
        assert.equal(state.config.ENERGY.reply_cost, 8);
        assert.equal(state.config.ENERGY.initial, DEFAULT_JUDGE_CONFIG.ENERGY.initial);
        assert.equal(state.config.GATE.max_calls_per_hour, 30);
    },

    testDecisionScheduleDebounce(): void {
        const fake = fakeScheduler();
        let now = 1000;
        const schedule = new DecisionSchedule({ scheduler: fake.scheduler, now: () => now });
        let due = 0;
        schedule.setHandler(async () => { due++; });
        const candidate = { session: { sessionId: 's1' } as never, ctx: {} as never, msg: {} as never, text: 'hi' };
        schedule.schedule(candidate, 4000);
        assert.equal(schedule.hasPending('s1'), true);
        assert.equal(fake.pending(), 1);
        now += 4000;
        fake.runAll();
        assert.equal(due, 1);
        assert.equal(schedule.hasPending('s1'), false);
    },

    testDecisionScheduleReplaceAndCancel(): void {
        const fake = fakeScheduler();
        const schedule = new DecisionSchedule({ scheduler: fake.scheduler, now: () => 0 });
        let due = 0;
        schedule.setHandler(async () => { due++; });
        const candidate = { session: { sessionId: 's1' } as never, ctx: {} as never, msg: {} as never, text: 'hi' };
        schedule.schedule(candidate, 4000);
        schedule.schedule(candidate, 6000);
        assert.equal(fake.pending(), 1, '同会话新候选应覆盖旧定时器');
        schedule.cancelForSession('s1');
        assert.equal(fake.pending(), 0);
        fake.runAll();
        assert.equal(due, 0);
    },

    testDecisionScheduleInflight(): void {
        const schedule = new DecisionSchedule({ scheduler: fakeScheduler().scheduler });
        assert.equal(schedule.markInflight('s1'), true);
        assert.equal(schedule.markInflight('s1'), false, '同一会话只允许一个在飞');
        schedule.clearInflight('s1');
        assert.equal(schedule.markInflight('s1'), true);
        assert.deepEqual(schedule.stats(), { pending: 0, inflight: 1, probes: 0 });
    },

    testDecisionScheduleProbeBackoff(): void {
        const schedule = new DecisionSchedule({ scheduler: fakeScheduler().scheduler, now: () => 0 });
        schedule.armProbe('s1', 90);
        assert.equal(schedule.probeNextAt('s1'), 90_000);
        schedule.backoffProbe('s1', 2, 600);
        assert.ok((schedule.probeNextAt('s1') || 0) > 90_000);
        schedule.cancelProbe('s1');
        assert.equal(schedule.probeNextAt('s1'), null);
    },
};
