// 单测：判定配置 v2（现行字段/默认值/旧键忽略） + 判定调度（在飞合并）。
import assert from 'node:assert/strict';

import { DEFAULT_JUDGE_CONFIG, JUDGE_TOML_DEFAULT, parseJudgeConfig } from '../src/judge/config';
import { DecisionSchedule } from '../src/pipeline/decision_schedule';

export const tests = {
    testJudgeConfigV2DefaultTemplateValid(): void {
        const state = parseJudgeConfig(JUDGE_TOML_DEFAULT);
        assert.equal(state.valid, true, state.errors.join(';'));
        assert.equal(state.config.DECISION.aggressiveness, 2);
        assert.equal(state.config.SCORING.speak_threshold, 0.6);
        assert.equal(state.config.SCORING.wait_cooldown, 30);
        assert.ok(JUDGE_TOML_DEFAULT.includes('speak_threshold = 0.6'), '默认模板应展示阈值 0.6');
        assert.ok(!JUDGE_TOML_DEFAULT.includes('shadow'), '默认模板不应再出现 shadow');
        assert.ok(!JUDGE_TOML_DEFAULT.includes('[gate]'), '默认模板不再有 [gate]');
        assert.equal(state.config.WEIGHTS.interruption_risk, -3);
        assert.equal(state.config.MODEL.context_tokens, 1500);
    },

    testJudgeConfigRejectsEmptyAndV1(): void {
        const empty = parseJudgeConfig('');
        assert.equal(empty.valid, false);
        assert.ok(empty.errors[0].includes('未配置'));
        const v1 = parseJudgeConfig('[scoring]\nspeak_threshold = 0.7');
        assert.equal(v1.valid, false, '缺 version=2 应拒绝');
        const bad = parseJudgeConfig('version = 2\n[decision]\naggressiveness = 9');
        assert.equal(bad.valid, false);
    },

    /** 范围校验：负数/越界拒绝；旧段/键忽略 */
    testJudgeConfigRangeValidation(): void {
        const bad = (toml: string): string[] => parseJudgeConfig(toml).errors;
        assert.ok(bad('version = 2\n[model]\nretries = -1').some(e => e.includes('retries')), 'retries 负数应拒绝');
        assert.ok(bad('version = 2\n[model]\ntimeout_sec = 0').some(e => e.includes('timeout_sec')), 'timeout_sec 0 应拒绝');
        assert.ok(bad('version = 2\n[scoring]\nspeak_threshold = 1.5').some(e => e.includes('speak_threshold')), 'speak 越界应拒绝');
        assert.ok(bad('version = 2\n[scoring]\nwait_cooldown = -1').some(e => e.includes('wait_cooldown')), 'wait_cooldown 负数应拒绝');
        // 旧配置段/键不再校验，按未知键忽略
        assert.equal(parseJudgeConfig('version = 2\n[energy]\ninitial = 1').valid, true);
        assert.equal(parseJudgeConfig('version = 2\n[gate]\ncall_burst = 0').valid, true);
        assert.equal(parseJudgeConfig('version = 2\n[features]\ninterruption_veto = 1.5').valid, true);
        assert.equal(parseJudgeConfig('version = 2\n[probe]\nenabled = true').valid, true);
        assert.equal(parseJudgeConfig('version = 2\n[decision]\nshadow = true').valid, true);
    },

    testJudgeConfigPartialOverride(): void {
        const state = parseJudgeConfig('version = 2\n[scoring]\nwait_cooldown = 45');
        assert.equal(state.valid, true, state.errors.join(';'));
        assert.equal(state.config.SCORING.wait_cooldown, 45);
        assert.equal(state.config.SCORING.speak_threshold, DEFAULT_JUDGE_CONFIG.SCORING.speak_threshold);
        assert.equal(state.config.MODEL.timeout_sec, DEFAULT_JUDGE_CONFIG.MODEL.timeout_sec);
        // 旧 energy 段被忽略，不影响默认值
        const legacy = parseJudgeConfig('version = 2\n[energy]\nreply_cost = 8');
        assert.equal(legacy.valid, true);
        assert.equal((legacy.config as any).ENERGY, undefined);
    },

    /** requestNow：入口立即派发；同会话在飞期间只保留最新候选，结束后补跑 */
    async testDecisionScheduleInflightMergesQueued(): Promise<void> {
        const schedule = new DecisionSchedule();
        const seen: string[] = [];
        let release: (() => void) | null = null;
        schedule.setHandler(async (c) => {
            seen.push(c.text);
            await new Promise<void>(resolve => { release = resolve; });
        });
        const cand = (text: string) => ({ session: { sessionId: 's1' } as never, ctx: {} as never, msg: {} as never, text, source: 'message' as const });
        schedule.requestNow(cand('first'));
        await Promise.resolve();
        assert.deepEqual(seen, ['first']);
        schedule.requestNow(cand('second'));
        schedule.requestNow(cand('third'));
        assert.equal(schedule.hasQueued('s1'), true, '在飞期间候选应合并排队');
        assert.equal(schedule.stats().inflight, 1, '同一会话只允许一个在飞');
        release!();
        await new Promise(resolve => setTimeout(resolve, 0));
        await Promise.resolve();
        assert.deepEqual(seen, ['first', 'third'], '在飞期间只保留最新候选');
        assert.equal(schedule.hasQueued('s1'), false, '补跑后队列应清空');
    },

    /** cancelForSession：清掉排队，避免关闸后补跑 */
    testDecisionScheduleCancelForSession(): void {
        const schedule = new DecisionSchedule();
        let release: (() => void) | null = null;
        let due = 0;
        schedule.setHandler(async () => {
            due++;
            await new Promise<void>(resolve => { release = resolve; });
        });
        const cand = { session: { sessionId: 's2' } as never, ctx: {} as never, msg: {} as never, text: 'x' };
        schedule.requestNow(cand);
        schedule.requestNow({ ...cand, text: 'y' });
        schedule.cancelForSession('s2');
        assert.equal(schedule.hasQueued('s2'), false);
        release!();
        assert.equal(due, 1);
    },
};
