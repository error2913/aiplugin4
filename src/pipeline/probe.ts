// 静默探针（L4，内存调度，默认关）：群聊长时间没人说话时，由判定内核评估"要不要主动开口"。
//
// 方案 §6.4.2 / C5：探针不进 timerQueue（5s 轮询 + 2s/条会污染高频语义），纯内存 setTimeout；
// 重载即丢（文档化）。触发条件（全部满足才评估）：
// - `[probe] enabled=true`（默认 false ⇒ R1 行为零变化）
// - 会话 `aiEnabled && judge` 开启、群聊、非忙、无认领
// - 全局「触发活跃时间」已配置且当前在窗口内
// - 0:00–7:00 静默不探
// - 距最近一条群消息 ≥ first_gap_sec；失败/无消息后按 backoff 增长至 max_gap_sec
import Config from "../config/config";
import { logger } from "../logger";
import type { Session } from "../session/session";
import { getSessionCtxAndMsg } from "../utils/seal";
import { createMsg } from "../utils/seal";
import { activeSegmentIndex } from "../utils/time_window";


import { claimTable } from "./claim_table";
import { decisionSchedule } from "./decision_schedule";


const log = logger.withTag('probe');

export interface ProbeScheduler {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

let scheduler: ProbeScheduler = {
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface ProbeState {
    timer: unknown;
    /** 最近一次收到群消息的时间（毫秒） */
    lastMessageAt: number;
    /** 当前探测间隔（秒） */
    gapSec: number;
}

const states = new Map<string, ProbeState>();

/** 仅测试：替换调度器（vi 式假时钟）并清空状态 */
export function setProbeSchedulerForTest(next: ProbeScheduler | null): void {
    cancelAllProbes();
    scheduler = next || {
        setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
        clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
}

function probeConfig() {
    return Config.trigger.JUDGE.PROBE;
}

function insideAwakeHours(now: number): boolean {
    const hour = new Date(now).getHours();
    return !(hour >= 0 && hour < 7);
}

function insideActiveWindow(now: number): boolean {
    const segments = Config.trigger.ACTIVE_TIME_SEGMENTS;
    if (segments.length === 0) return false;
    return activeSegmentIndex(segments, new Date(now)) >= 0;
}

function clearTimer(state: ProbeState): void {
    if (state.timer !== null && state.timer !== undefined) scheduler.clearTimeout(state.timer);
    state.timer = null;
}

function schedule(session: Session, ctx: seal.MsgContext, delaySec: number): void {
    const state = states.get(session.sessionId);
    if (!state) return;
    clearTimer(state);
    state.timer = scheduler.setTimeout(() => {
        void runProbe(session, ctx);
    }, Math.max(1, delaySec) * 1000);
}

async function runProbe(session: Session, ctx: seal.MsgContext): Promise<void> {
    const sid = session.sessionId;
    const state = states.get(sid);
    if (!state) return;
    const cfg = probeConfig();
    if (!cfg.enabled) {
        cancelProbe(sid);
        return;
    }
    const now = Date.now();
    const gap = (now - state.lastMessageAt) / 1000;
    const blocked = !session.setting.aiEnabled
        || !session.setting.judge
        || session.running
        || session.starting
        || ctx.isPrivate
        || claimTable.hasClaimForSession(sid)
        || !insideAwakeHours(now)
        || !insideActiveWindow(now)
        || gap < cfg.first_gap_sec;
    if (blocked) {
        // 不满足条件：按退避再等（不改变 lastMessageAt）
        state.gapSec = Math.min(state.gapSec * Math.max(1, cfg.backoff), Math.max(1, cfg.max_gap_sec));
        schedule(session, ctx, state.gapSec);
        return;
    }

    // 到点评估：候选文本取最近一条 user 内容（探针不产生新消息，只重新审视会话状态）
    let text = '';
    const messages = session.context.messages as any[];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || message.role !== 'user') continue;
        const items = message.contentItems || message.msgArray || [];
        const last = items[items.length - 1];
        text = String((last && last.text) || message.text || '').trim();
        if (text) break;
    }
    if (!text) {
        state.gapSec = Math.min(state.gapSec * Math.max(1, cfg.backoff), Math.max(1, cfg.max_gap_sec));
        schedule(session, ctx, state.gapSec);
        return;
    }
    log.info(`静默探针触发：sid=${sid} 静默${Math.round(gap)}s ≥ ${cfg.first_gap_sec}s`);
    let nextCtx = ctx;
    try {
        const { ctx: freshCtx, msg } = getSessionCtxAndMsg(ctx.endPoint.userId, sid, ctx.isPrivate);
        nextCtx = freshCtx;
        // 探针与消息/轮末共用同一「在飞去重」入口（在飞 ⇒ 合并为排队，不并发调模型）
        decisionSchedule.requestNow({ session, ctx: freshCtx, msg, text, source: 'probe' });
    } catch (e) {
        // 端点未注册等场景：退回现有 ctx + 合成 msg，仍交给判定内核（失败只记日志）
        try {
            const fallbackMsg = createMsg(ctx.isPrivate ? 'private' : 'group', ctx.player?.userId || '', ctx.group?.groupId || '');
            decisionSchedule.requestNow({ session, ctx, msg: fallbackMsg, text, source: 'probe' });
        } catch (inner) {
            log.warning(`静默探针评估失败（已忽略）：${inner instanceof Error ? inner.message : String(inner)}`);
        }
        log.warning(`静默探针上下文重建失败（已回退 ${e instanceof Error ? e.message : String(e)}）`);
    }
    state.gapSec = Math.min(state.gapSec * Math.max(1, cfg.backoff), Math.max(1, cfg.max_gap_sec));
    schedule(session, nextCtx, state.gapSec);
}

/**
 * 记录一条群消息活动并（重）排探针。
 * 调用点：消息入口入库后；默认配置 `[probe] enabled=false` 时本函数立即返回（零开销/零行为）。
 */
export function noteProbeActivity(session: Session, ctx: seal.MsgContext): void {
    const cfg = probeConfig();
    if (!cfg.enabled) return;
    if (ctx.isPrivate || !session.setting.aiEnabled || !session.setting.judge) return;
    const sid = session.sessionId;
    let state = states.get(sid);
    if (!state) {
        state = { timer: null, lastMessageAt: Date.now(), gapSec: Math.max(1, cfg.first_gap_sec) };
        states.set(sid, state);
    }
    state.lastMessageAt = Date.now();
    state.gapSec = Math.max(1, cfg.first_gap_sec);
    schedule(session, ctx, cfg.first_gap_sec);
}

/** 取消某会话探针（.ai off / stop / 会话销毁 / 判分关闭） */
export function cancelProbe(sid: string): void {
    const state = states.get(sid);
    if (!state) return;
    clearTimer(state);
    states.delete(sid);
}

export function cancelAllProbes(): void {
    for (const sid of [...states.keys()]) cancelProbe(sid);
}

/** 观测：探针下次/当前间隔（`.ai status` 可选） */
export function probeInfo(sid: string): { gapSec: number; lastMessageAt: number } | null {
    const state = states.get(sid);
    return state ? { gapSec: state.gapSec, lastMessageAt: state.lastMessageAt } : null;
}
