// 规则/模式定时器到点处理（L4）：实现 trigger_timer 端口的 handler 半边。
//
// 方案 §5.5/§5.10：
// - TimerManager.task() 识别 ruleId 条目后不再按旧语义消费，只调 owns()/fire()；
// - 生命周期（一次性移除、interval 递减续期、规则被删则清理）由本模块负责；
// - 规则 fire 复用 runChain(sourceSatisfied=true)，保证与消息/事件入口同一求值/起轮路径；
// - 隐式模式 timer（mode:<sid>）不建规则，直接按 prompts 起轮。
import { getSessionById } from "../core/ports/session_lookup";
import { addRuleTimer, listRuleTimers, removeRuleTimer, removeRuleTimers, setTriggerTimerHandler } from "../core/ports/trigger_timer";
import type { RuleTimerTarget } from "../core/ports/trigger_timer";
import { logger } from "../logger";
import type { TimerInfo } from "../timer";
import type { TriggerRule } from "../trigger";
import { applyLastMessageRef, getSessionCtxAndMsg } from "../utils/seal";
import { activeSubSegmentOccurrence, nextActiveTimeStart, parseActiveTimeGate } from "../utils/time_window";
import { pickPrompt, validateTimerSpec } from "../utils/timer_spec";

import { DEFAULT_RULE_WAKE_TEXT, getRuleStore, ruleSkipReason, runChain } from "./trigger_rule";
import { wakeSession } from "./wake";


const log = logger.withTag('trigger-timer');

function isModeTimer(timer: TimerInfo): boolean {
    return typeof timer.ruleId === 'string' && timer.ruleId.startsWith('mode:');
}

/** 端口 owns：只认规则/模式条目（规则被删则不再认领，交由 task 清理） */
export function ownsRuleTimer(timer: TimerInfo): boolean {
    if (!timer.ruleId) return false;
    if (isModeTimer(timer)) return true;
    return !!getRuleStore().getById(timer.ruleId);
}

/** 规则是否仍可继续调度（存在且未停用/过期/次数用尽）；模式 timer 不走规则库，由调用方跳过 */
function ruleTimerStillActive(ruleId: string, sid: string): boolean {
    const rule = getRuleStore().getById(ruleId);
    if (!rule) return false;
    const fired = getRuleStore().readState(ruleId)[sid]?.fired ?? 0;
    return ruleSkipReason(rule, fired, Date.now()) === null;
}

/**
 * 续期/消费一条规则定时器：
 * - 先精确移除当前这一条（多 [[timer]] 计划共用 ruleId 时不能整组删）；
 * - interval 且还有剩余次数：按原间隔续期（count 减 1）；
 * - 否则彻底移除。
 */
function advanceTimer(timer: TimerInfo, consumed: boolean): void {
    const ruleId = timer.ruleId || '';
    removeRuleTimer(timer);
    // fire 是异步的：期间规则可能被删除/停用/次数用尽，此时绝不能把定时器加回去，
    // 否则留下"规则已删但定时器仍每轮点火"的幽灵条目（owns() 会永久 false + 刷告警）。
    if (!isModeTimer(timer) && !ruleTimerStillActive(ruleId, timer.sid)) return;
    if (!consumed) {
        // 未消费（门不通过/未真正起轮）：interval 保持原次数等下一轮；target 不补
        if (timer.type === 'interval' && timer.interval > 0) {
            addRuleTimer(
                { sid: timer.sid, isPrivate: timer.isPrivate, epId: timer.epId },
                { ruleId, modeTag: timer.modeTag || 'rule', type: 'interval', interval: timer.interval, count: timer.count, prompts: timer.prompts },
            );
        }
        return;
    }
    const remaining = timer.count === -1 ? -1 : timer.count - 1;
    if (timer.type === 'interval' && timer.interval > 0 && (remaining === -1 || remaining > 0)) {
        addRuleTimer(
            { sid: timer.sid, isPrivate: timer.isPrivate, epId: timer.epId },
            { ruleId, modeTag: timer.modeTag || 'rule', type: 'interval', interval: timer.interval, count: remaining, prompts: timer.prompts },
        );
    }
}

/** 标记 active_time 规则已消费的段（occurrence：当天序号×segs+子段下标） */
function markActiveTimeOccurrence(ruleId: string, sid: string, occurrence: number): void {
    const store = getRuleStore();
    const map = store.readState(ruleId);
    const shard = map[sid] || { fired: 0, lastFiredAt: 0, gates: {} };
    const gates = { ...(shard.gates || {}) };
    gates['active_time'] = { count: occurrence, lastPassAt: Date.now() };
    map[sid] = { ...shard, gates };
    store.writeState(ruleId, map, true);
}

/** active_time 规则：排下一个子段起点（unix 秒；失败返回 -1） */
function scheduleNextActiveTimeRule(rule: TriggerRule, target: RuleTimerTarget): number {
    const gate = rule.gates[0];
    if (!gate || gate.type !== 'active_time') return -1;
    const segment = parseActiveTimeGate(gate);
    if (!segment) return -1;
    const next = nextActiveTimeStart(segment);
    if (next <= 0) return -1;
    addRuleTimer(target, { ruleId: rule.id, modeTag: 'rule', type: 'target', target: next, count: 1 });
    return next;
}

/** 重建会话上下文；失败返回 null（调用方清理定时器） */
function rebuildContext(timer: TimerInfo): { session: ReturnType<typeof getSessionById>; ctx: seal.MsgContext; msg: seal.Message } | null {
    try {
        const session = getSessionById(timer.sid);
        const { ctx, msg } = getSessionCtxAndMsg(timer.epId, timer.sid, timer.isPrivate);
        applyLastMessageRef(session, ctx, msg);
        return { session, ctx, msg };
    } catch (e) {
        log.warning(`无法重建会话上下文 ${timer.sid}（${e instanceof Error ? e.message : String(e)}），规则定时器已清理`);
        return null;
    }
}

/** 端口 fire：规则/模式定时器到点 */
export async function fireRuleTimer(timer: TimerInfo): Promise<void> {
    const ruleId = timer.ruleId || '';
    const rebuilt = rebuildContext(timer);
    if (!rebuilt) {
        removeRuleTimer(timer);
        return;
    }
    const { session, ctx, msg } = rebuilt;

    if (isModeTimer(timer)) {
        const outcome = await wakeSession(session, ctx, msg, {
            kind: 'mode',
            wakeText: pickPrompt(timer.prompts) || DEFAULT_RULE_WAKE_TEXT,
            reason: '定时器',
            raw: { mode: 'timer', modeTag: timer.modeTag },
        });
        advanceTimer(timer, outcome === 'fired');
        return;
    }

    const rule = getRuleStore().getById(ruleId);
    const activeGate = rule && rule.gates[0] && rule.gates[0].type === 'active_time' ? rule.gates[0] : null;

    // target 型一次性条目超时 1 小时不再补发（与旧 target 语义一致）；active_time 规则改为重排下一段
    if (activeGate) {
        const target: RuleTimerTarget = { sid: timer.sid, isPrivate: timer.isPrivate, epId: timer.epId };
        const segment = parseActiveTimeGate(activeGate);
        const occurrence = segment ? activeSubSegmentOccurrence(segment) : -1;
        const prev = occurrence >= 0
            ? (getRuleStore().readState(ruleId)[timer.sid]?.gates?.['active_time']?.count ?? -1)
            : -1;
        advanceTimer(timer, true);
        try {
            if (occurrence >= 0 && prev !== occurrence) {
                markActiveTimeOccurrence(ruleId, timer.sid, occurrence);
                await runChain({
                    session,
                    ctx,
                    msg,
                    ruleId,
                    sourceSatisfied: true,
                    userId: ctx.player?.userId,
                    platform: ctx.endPoint?.platform,
                });
                // persistFired 会清 gates，重写一次保证"每段最多 1 次"（重载/重复投递也不重复触发）
                markActiveTimeOccurrence(ruleId, timer.sid, occurrence);
            }
        } finally {
            if (ruleTimerStillActive(ruleId, timer.sid)) scheduleNextActiveTimeRule(rule, target);
        }
        return;
    }

    if (timer.type === 'target' && timer.target > 0 && Math.floor(Date.now() / 1000) - timer.target >= 60 * 60) {
        log.info(`${timer.sid} 的规则定时器 ${ruleId} 超时一小时，忽略执行`);
        removeRuleTimer(timer);
        return;
    }

    const result = await runChain({
        session,
        ctx,
        msg,
        ruleId,
        sourceSatisfied: true,
        userId: ctx.player?.userId,
        platform: ctx.endPoint?.platform,
    });
    advanceTimer(timer, result.status === 'fired');
}

let installed = false;
/** 注册 handler 半边（幂等；由启动装配在 TimerManager.init 前调用） */
export function installTriggerTimerHandler(): void {
    if (installed) return;
    installed = true;
    setTriggerTimerHandler({ owns: ownsRuleTimer, fire: fireRuleTimer });
}

/**
 * 补注册规则 timer 条目（幂等）：会话恢复/开启 AI 时按规则库重建缺失的条目。
 * timer 源规则要求显式会话列表，因此只处理 sessions 命中 sid 的规则。
 */
export function ensureRuleTimersForSession(target: RuleTimerTarget): number {
    const store = getRuleStore();
    let added = 0;
    for (const rule of store.list()) {
        if (!rule.enabled) continue;
        const gate = rule.gates[0];
        if (!gate || (gate.type !== 'timer' && gate.type !== 'active_time')) continue;
        if (!(rule.scope.sessions || []).includes(target.sid)) continue;
        if (listRuleTimers(rule.id).some(timer => timer.sid === target.sid)) continue;
        if (gate.type === 'active_time') {
            if (scheduleNextActiveTimeRule(rule, target) > 0) added++;
            continue;
        }
        const parsed = validateTimerSpec(gate);
        if (!parsed.ok || !parsed.spec) continue;
        addRuleTimer(target, {
            ruleId: rule.id,
            modeTag: 'rule',
            type: parsed.spec.types,
            target: parsed.spec.types === 'target' ? parsed.spec.targetAt : undefined,
            interval: parsed.spec.types === 'interval' ? parsed.spec.intervalSec : undefined,
            count: parsed.spec.types === 'target' ? 1 : (parsed.spec.count ?? 1),
            prompts: parsed.spec.prompts,
        });
        added++;
    }
    if (added > 0) log.info(`补注册规则定时器 ${added} 条（${target.sid}）`);
    return added;
}

/** 仅测试：卸载 handler */
export function resetTriggerTimerHandlerForTest(): void {
    installed = false;
    setTriggerTimerHandler(null);
}

/**
 * 装配期 reconcile：队列里规则已删/失效的条目清理掉，避免重载后遗留幽灵定时器。
 * 在 TimerManager.loadQueue() 之后、start() 之前调用。
 */
export function reconcileRuleTimers(): { kept: number; removed: number } {
    const timers = listRuleTimers();
    let removed = 0;
    for (const timer of timers) {
        if (!ownsRuleTimer(timer)) {
            removeRuleTimers(timer.ruleId || '');
            removed++;
        }
    }
    if (removed > 0) log.info(`规则定时器 reconcile：清理 ${removed} 条失效条目（保留 ${timers.length - removed} 条）`);
    return { kept: timers.length - removed, removed };
}

// 模块加载即注册：只要 index 装配 import 本模块，TimerManager 就能分派规则条目
installTriggerTimerHandler();
