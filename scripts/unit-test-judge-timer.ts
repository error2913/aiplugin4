// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：judge-timer 域，11 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Agent, Config, JudgeManager, TC,
    TEST_JUDGE_TOML, TimerManager, assert, getAuxLlm,
    makeCtx, makeJudgeSession, resetConfigCache, setAuxLlm,
} from './unit-test-helpers';

export const tests: Record<string, () => void | Promise<void>> = {
/** 配置：新默认；旧段/键忽略 */
    testJudgeConfigDefaults(): void {
        const key = '评分触发参数';
        TC.stringConfigs[key] = '';
        resetConfigCache();
        assert.equal((Config as any).trigger.JUDGE_VALID, false, '空配置应标记为不可用');

        TC.stringConfigs[key] = 'version = 2\n[scoring]\nspeak_threshold = 0.8\nwait_cooldown = 30';
        resetConfigCache();
        let cfg = (Config as any).trigger.JUDGE;
        assert.equal((Config as any).trigger.JUDGE_VALID, true, '合法 v2 应可用');
        assert.equal(cfg.SCORING.speak_threshold, 0.8);
        assert.equal(cfg.SCORING.wait_cooldown, 30);
        assert.equal(cfg.WEIGHTS.addressed, 4, '未配置段并入默认权重');
        assert.equal(cfg.MODEL.context_tokens, 1500);
        assert.equal(cfg.MODEL.timeout_sec, 8);
        assert.equal((cfg as any).ENERGY, undefined, '精力段已删除');
        assert.equal((cfg as any).GATE, undefined, '调用预算/预筛段已删除');

        // 旧段/键保留也能解析，只是忽略
        TC.stringConfigs[key] = 'version = 2\n[decision]\nshadow = true\n[energy]\ninitial = 1\n[gate]\ncall_burst = 0\n[probe]\nenabled = true';
        resetConfigCache();
        cfg = (Config as any).trigger.JUDGE;
        assert.equal((Config as any).trigger.JUDGE_VALID, true, '旧段不应导致配置失效');
        assert.equal((cfg.DECISION as any).shadow, undefined, 'shadow 已删除');
        assert.equal(cfg.SCORING.wait_cooldown, 30, '默认 WAIT 30s');

        TC.stringConfigs[key] = 'not = = toml';
        resetConfigCache();
        assert.equal((Config as any).trigger.JUDGE_VALID, false, '非法 TOML 应标记不可用');
        TC.stringConfigs[key] = '[scoring]\nwait_cooldown = 30';
        resetConfigCache();
        assert.equal((Config as any).trigger.JUDGE_VALID, false, '缺 version=2 应标记不可用');

        TC.stringConfigs[key] = TEST_JUDGE_TOML;
        resetConfigCache();
    }
,

    /** 被@触发：触发页配置开关（默认开；关闭后 @ 不再单独触发） */
    testTriggerAtConfigSwitch(): void {
        delete TC.boolConfigs['被@触发'];
        resetConfigCache();
        assert.equal((Config as any).trigger.AT_TRIGGER, true, '默认应为开');
        TC.boolConfigs['被@触发'] = false;
        resetConfigCache();
        assert.equal((Config as any).trigger.AT_TRIGGER, false, '配置关闭应生效');
        delete TC.boolConfigs['被@触发'];
        resetConfigCache();
        assert.equal((Config as any).trigger.AT_TRIGGER, true, '恢复默认后应为开');
    }
,

    /** 默认定时器：Template 每框一个 TimerSpec TOML；单框非法跳过、全非法拒绝、全空可用 */
    testTimerTemplateConfig(): void {
        const key = '默认定时器';
        delete TC.templateConfigs[key];
        resetConfigCache();
        let cfg = (Config as any).trigger.TIMER_SPECS;
        assert.equal(cfg.VALID, true);
        assert.equal(cfg.SPECS.length, 0);

        // 多框 = 多个定时器
        TC.templateConfigs[key] = [
            'types = "interval"\nhours = 12\ncount = -1\nprompts = ["a"]',
            'types = "target"\nyears = 2027\nmonths = 1\ndays = 1\nhours = 0\nminutes = 0\nprompts = ["b"]',
        ];
        resetConfigCache();
        cfg = (Config as any).trigger.TIMER_SPECS;
        assert.equal(cfg.VALID, true);
        assert.equal(cfg.SPECS.length, 2);
        assert.equal(cfg.SPECS[0].intervalSec, 12 * 3600);

        // 混合：一框非法只跳过该框
        TC.templateConfigs[key] = [
            'types = "interval"\nhours = 1\ncount = 0\nprompts = ["a"]',
            'types = "interval"\nhours = 12\ncount = -1\nprompts = ["x"]',
        ];
        resetConfigCache();
        cfg = (Config as any).trigger.TIMER_SPECS;
        assert.equal(cfg.VALID, true);
        assert.equal(cfg.SPECS.length, 1);

        // 全部非法（含 TOML 语法错误）→ VALID=false，trg timer on 拒绝
        TC.templateConfigs[key] = ['not = = toml'];
        resetConfigCache();
        cfg = (Config as any).trigger.TIMER_SPECS;
        assert.equal(cfg.VALID, false);

        TC.templateConfigs[key] = ['types = "interval"\nhours = 1\ncount = 0\nprompts = ["a"]'];
        resetConfigCache();
        cfg = (Config as any).trigger.TIMER_SPECS;
        assert.equal(cfg.VALID, false);

        delete TC.templateConfigs[key];
        resetConfigCache();
        assert.equal((Config as any).trigger.TIMER_SPECS.VALID, true);
    }
,

    /** 首条消息（IDLE）立即评分；评分 WAIT 后进入 30s WAIT */
    async testJudgeFirstMessageImmediate(): Promise<void> {
        const origNow = Date.now;
        let now = 1_700_000_000_000;
        Date.now = () => now;
        let calls = 0;
        (Agent as any).agentMap['judge_agent'] = {
            chatMessages: async () => {
                calls++;
                return JSON.stringify({ dims: { addressed: 0, help_signal: 0, relevance: 0, friendships: 0, silence_gap: 0, interruption_risk: 0 } });
            },
        };
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        let timers = 0;
        (TimerManager as any).addJudgeWaitTimer = () => { timers++; };
        const sid = 'judge-first';
        (JudgeManager as any).clearSession(sid);
        const session = makeJudgeSession(sid);
        try {
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '第一条');
            assert.equal(calls, 1, 'IDLE 首条应立即评分一次');
            const state = (JudgeManager as any).states.get(sid);
            assert.ok(state, '应创建 judge 状态');
            assert.equal(state.waitUntil, now + 30 * 1000, 'WAIT 结果后应进入 30s WAIT');
            assert.equal(state.pending, null, '评分时没有挂起消息');
            assert.equal(timers, 1, '应注册 judgeWait 定时器');
            assert.equal(state.energy, undefined, '旧精力字段已删除');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            (JudgeManager as any).clearSession(sid);
            delete (Agent as any).agentMap['judge_agent'];
            resetConfigCache();
        }
    }
,

    /** WAIT 30s：期间消息只挂起最新一条；到点只评最新一条；无 pending 不调模型 */
    async testJudgeWaitWindowHoldsAndScores(): Promise<void> {
        const origNow = Date.now;
        let now = 1_700_000_000_000;
        Date.now = () => now;
        let calls = 0;
        (Agent as any).agentMap['judge_agent'] = {
            chatMessages: async () => {
                calls++;
                return JSON.stringify({ dims: { addressed: 0, help_signal: 0, relevance: 0, friendships: 0, silence_gap: 0, interruption_risk: 0 } });
            },
        };
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        let timers = 0;
        (TimerManager as any).addJudgeWaitTimer = () => { timers++; };
        const sid = 'judge-wait-window';
        (JudgeManager as any).clearSession(sid);
        const session = makeJudgeSession(sid);
        try {
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '第一条');
            let state = (JudgeManager as any).states.get(sid);
            const deadline = state.waitUntil;
            assert.equal(deadline, now + 30 * 1000);
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, 'WAIT中第二条');
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, 'WAIT中第三条');
            assert.equal(calls, 1, 'WAIT 期间不应调模型');
            state = (JudgeManager as any).states.get(sid);
            assert.equal(state.pending.text, 'WAIT中第三条', '只保留最新挂起消息');
            assert.equal(state.waitUntil, deadline, '新消息不应延长 30s');
            now = deadline;
            const before = calls;
            assert.equal(await (JudgeManager as any).endWaitRound(sid), true);
            assert.equal(calls, before + 1, 'WAIT 到点应只评挂起消息一次');
            state = (JudgeManager as any).states.get(sid);
            assert.equal(state.waitUntil, now + 30 * 1000, '轮末 WAIT 结果应进入新的 30s WAIT');
            assert.equal(state.pending, null, '评分后 pending 清空');
            now = state.waitUntil;
            const after = calls;
            await (JudgeManager as any).endWaitRound(sid);
            assert.equal(calls, after, '无 pending 时轮末不应调模型');
            state = (JudgeManager as any).states.get(sid);
            assert.equal(state.waitUntil, 0, '无 pending 结束本轮');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            (JudgeManager as any).clearSession(sid);
            delete (Agent as any).agentMap['judge_agent'];
            resetConfigCache();
        }
    }
,

    /** SPEAK 回复成功：noteSessionTrigger 进入 30s WAIT */
    async testJudgeSpeakEntersWait(): Promise<void> {
        const origNow = Date.now;
        const now = 1_700_000_000_000;
        Date.now = () => now;
        let calls = 0;
        let chats = 0;
        (Agent as any).agentMap['judge_agent'] = {
            chatMessages: async () => {
                calls++;
                return JSON.stringify({ dims: { addressed: 10, help_signal: 10, relevance: 10, friendships: 10, silence_gap: 10, interruption_risk: 0 } });
            },
        };
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        (TimerManager as any).addJudgeWaitTimer = () => { };
        const sid = 'judge-speak-wait';
        (JudgeManager as any).clearSession(sid);
        const session: any = makeJudgeSession(sid);
        session.chat = async () => {
            chats++;
            JudgeManager.noteSessionTrigger(makeCtx(), session, '评分触发');
            return 'fired';
        };
        try {
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '点名');
            assert.equal(calls, 1);
            assert.equal(chats, 1, '高分应起轮回复');
            const state = (JudgeManager as any).states.get(sid);
            assert.equal(state.waitUntil, now + 30 * 1000, '回复成功后应进入 30s WAIT');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            (JudgeManager as any).clearSession(sid);
            delete (Agent as any).agentMap['judge_agent'];
            resetConfigCache();
        }
    }
,

    /** 活跃时间/计时器挂起/会话忙/密度都不再是评分闸门 */
    async testJudgeNoGateConditions(): Promise<void> {
        const origNow = Date.now;
        const now = new Date(2026, 0, 1, 22, 0, 0).getTime();
        Date.now = () => now;
        TC.templateConfigs['触发活跃时间'] = ['10:00-20:00-5'];
        resetConfigCache();
        let calls = 0;
        let chats = 0;
        (Agent as any).agentMap['judge_agent'] = {
            chatMessages: async () => {
                calls++;
                return JSON.stringify({ dims: { addressed: 10, help_signal: 10, relevance: 10, friendships: 10, silence_gap: 10, interruption_risk: 0 } });
            },
        };
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        (TimerManager as any).addJudgeWaitTimer = () => { };
        const sid = 'judge-no-gate';
        (JudgeManager as any).clearSession(sid);
        const session: any = makeJudgeSession(sid);
        session.context.timer = 1;
        session.running = true;
        session.starting = true;
        session.chat = async () => { chats++; return 'fired'; };
        try {
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '22点消息');
            assert.equal(calls, 1, '活跃时间外仍应评分');
            assert.equal(chats, 1, '会话忙/计时器挂起不应阻止 SPEAK');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            delete TC.templateConfigs['触发活跃时间'];
            (JudgeManager as any).clearSession(sid);
            delete (Agent as any).agentMap['judge_agent'];
            resetConfigCache();
        }
    }
,

    /** System One 决策模型：走 systemOne，不调用 chatMessages */
    async testJudgeDecisionBackend(): Promise<void> {
        const prevAux = getAuxLlm();
        const origNow = Date.now;
        const now = 1_700_000_000_000;
        Date.now = () => now;
        let systemCalls = 0;
        let chatCalls = 0;
        let replyChats = 0;
        setAuxLlm({
            chat: async () => '',
            chatMessages: async () => { chatCalls++; throw new Error('chat backend should not be used'); },
            hasModel: async () => true,
            modelKind: async () => 'decision',
            systemOne: async () => {
                systemCalls++;
                return {
                    answers: {
                        addressed: { type: 'score', score: 9 },
                        help_signal: { type: 'score', score: 9 },
                        relevance: { type: 'score', score: 9 },
                        friendships: { type: 'score', score: 9 },
                        silence_gap: { type: 'score', score: 9 },
                        interruption_risk: { type: 'score', score: 0 },
                    },
                };
            },
        });
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        (TimerManager as any).addJudgeWaitTimer = () => { };
        const sid = 'judge-decision';
        (JudgeManager as any).clearSession(sid);
        const session: any = makeJudgeSession(sid);
        session.chat = async () => { replyChats++; return 'fired'; };
        try {
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '点名');
            assert.equal(systemCalls, 1, 'decision 后端应调用 systemOne 一次');
            assert.equal(chatCalls, 0, 'decision 后端不应调用 chatMessages');
            assert.equal(replyChats, 1, '高分应起轮');
            const state = (JudgeManager as any).states.get(sid);
            assert.equal(state.lastDecision.backend, 'decision');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            (JudgeManager as any).clearSession(sid);
            setAuxLlm(prevAux);
            resetConfigCache();
        }
    }
,

    /** wait_cooldown=0：不进入 WAIT，消息每次都立即评分 */
    async testJudgeWaitCooldownZero(): Promise<void> {
        const origNow = Date.now;
        const now = 1_700_000_000_000;
        Date.now = () => now;
        TC.stringConfigs['评分触发参数'] = 'version = 2\n[scoring]\nwait_cooldown = 0';
        resetConfigCache();
        let calls = 0;
        (Agent as any).agentMap['judge_agent'] = {
            chatMessages: async () => {
                calls++;
                return JSON.stringify({ dims: { addressed: 0, help_signal: 0, relevance: 0, friendships: 0, silence_gap: 0, interruption_risk: 0 } });
            },
        };
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        let timers = 0;
        (TimerManager as any).addJudgeWaitTimer = () => { timers++; };
        const sid = 'judge-wait-zero';
        (JudgeManager as any).clearSession(sid);
        const session = makeJudgeSession(sid);
        try {
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '第一条');
            await (JudgeManager as any).evaluate(makeCtx(), {}, session, '第二条');
            assert.equal(calls, 2, 'wait_cooldown=0 时每条消息都立即评分');
            const state = (JudgeManager as any).states.get(sid);
            assert.equal(state.waitUntil, 0);
            assert.equal(timers, 0);
            JudgeManager.noteSessionTrigger(makeCtx(), session, '正则');
            assert.equal(timers, 0, 'wait_cooldown=0 不注册定时器');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            (JudgeManager as any).clearSession(sid);
            delete (Agent as any).agentMap['judge_agent'];
            delete TC.stringConfigs['评分触发参数'];
            resetConfigCache();
        }
    }
,

    /** 清理会话 judge 状态：移除状态与 WAIT 定时器，重复清理不抛错 */
    testJudgeClearSession(): void {
        const sid = 'clear-me';
        (JudgeManager as any).states.set(sid, { waitUntil: Date.now() + 60000, pending: null, timeline: [] });
        (JudgeManager as any).clearSession(sid);
        assert.equal((JudgeManager as any).states.has(sid), false, '应移除 judge 状态');
        (JudgeManager as any).clearSession(sid);
    }
,

    /** startWaitTimer 去重：同一会话新 WAIT 先清旧 judgeWait 定时器 */
    testJudgeWaitTimerDedup(): void {
        const origNow = Date.now;
        const fakeNow = 1_700_000_000_000;
        Date.now = () => fakeNow;
        const origAdd = (TimerManager as any).addJudgeWaitTimer;
        const sid = 'wait-dedup';
        (TimerManager as any).addJudgeWaitTimer = (_ctx: any, _session: any, target: number) => {
            TimerManager.timerQueue.push({ sid, type: 'judgeWait', target } as any);
        };
        try {
            (JudgeManager as any).noteSessionTrigger(makeCtx(), makeJudgeSession(sid), '正则');
            (JudgeManager as any).noteSessionTrigger(makeCtx(), makeJudgeSession(sid), '计数');
            const timers = TimerManager.getTimers(sid, '', ['judgeWait']);
            assert.equal(timers.length, 1, '同一会话只应保留一个 WAIT 定时器');
        } finally {
            Date.now = origNow;
            (TimerManager as any).addJudgeWaitTimer = origAdd;
            TimerManager.timerQueue = TimerManager.timerQueue.filter(t => t.sid !== sid);
            (JudgeManager as any).clearSession(sid);
            resetConfigCache();
        }
    }
};
