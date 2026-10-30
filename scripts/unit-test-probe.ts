// M4 单测：静默探针（默认关零行为；开启后条件过滤与退避调度，注入式时钟）。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { claimTable } from '../src/pipeline/claim_table';
import { decisionSchedule } from '../src/pipeline/decision_schedule';
import { cancelAllProbes, noteProbeActivity, probeInfo, setProbeSchedulerForTest } from '../src/pipeline/probe';
import { Session } from '../src/session/session';

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
const origNow = Date.now;

function fakeScheduler() {
    const timers = new Map<number, () => void>();
    let seq = 0;
    return {
        scheduler: {
            setTimeout: (fn: () => void) => { const id = ++seq; timers.set(id, fn); return id; },
            clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
        },
        runPending: () => {
            for (const [id, fn] of [...timers.entries()]) {
                timers.delete(id);
                fn();
            }
        },
        size: () => timers.size,
    };
}

function installProbeConfig(enabled: boolean): void {
    (Config as unknown as { trigger: unknown }).trigger = {
        JUDGE: {
            PROBE: { enabled, first_gap_sec: 90, backoff: 2, max_gap_sec: 600 },
            GATE: { max_calls_per_hour: 30 },
            ENERGY: { initial: 100 },
        },
        ACTIVE_TIME_SEGMENTS: [{ start: 0, end: 1439, segs: 1 }],
    };
}

function makeSession(sid: string): Session {
    const session = new Session();
    session.sessionId = sid;
    session.setting.aiEnabled = true;
    session.setting.judge = true;
    session.context.messages = [{ role: 'user', contentItems: [{ text: '有人吗' }] } as never];
    return session;
}

function makeCtx(): seal.MsgContext {
    return { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:20000' }, group: { groupId: 'QQ-Group:1' }, isPrivate: false } as unknown as seal.MsgContext;
}

export const tests = {
    testProbeDisabledNoop(): void {
        installProbeConfig(false);
        const session = makeSession('QQ-Group:p-off');
        noteProbeActivity(session, makeCtx());
        assert.equal(probeInfo('QQ-Group:p-off'), null, '默认关闭时不创建探针状态');
        cancelAllProbes();
    },

    testProbeSchedulesAndBacksOff(): void {
        installProbeConfig(true);
        cancelAllProbes();
        claimTable.releaseSession('QQ-Group:p-on');
        const fake = fakeScheduler();
        setProbeSchedulerForTest(fake.scheduler);
        const called: string[] = [];
        // R2：探针与消息/轮末共用决策调度入口（在飞去重），测试桩改为记录 requestNow 候选
        const origRequestNow = decisionSchedule.requestNow;
        (decisionSchedule as unknown as { requestNow: (candidate: { text: string }) => void }).requestNow = (candidate) => { called.push(candidate.text); };
        try {
            const session = makeSession('QQ-Group:p-on');
            const ctx = makeCtx();
            // 固定时间：正午（避免 0-7 静默）
            Date.now = () => NOW;
            noteProbeActivity(session, ctx);
            assert.equal(fake.size(), 1, '开启后应排一个探针定时器');
            assert.equal(probeInfo('QQ-Group:p-on')?.gapSec, 90);

            // 首次到点：静默不足 90s → 不评估，按 backoff 退避
            Date.now = () => NOW + 30_000;
            fake.runPending();
            assert.equal(called.length, 0, '静默不足时不应评估');
            assert.equal(fake.size(), 1, '应继续排下一次');
            assert.equal(probeInfo('QQ-Group:p-on')?.gapSec, 180);

            // 再次到点：静默已 ≥ first_gap → 评估一次
            Date.now = () => NOW + 400_000;
            fake.runPending();
            assert.equal(called.length, 1, '静默足够时应评估一次');
            assert.equal(called[0], '有人吗');
        } finally {
            Date.now = origNow;
            (decisionSchedule as unknown as { requestNow: typeof decisionSchedule.requestNow }).requestNow = origRequestNow;
            cancelAllProbes();
            setProbeSchedulerForTest(null);
        }
    },
};
