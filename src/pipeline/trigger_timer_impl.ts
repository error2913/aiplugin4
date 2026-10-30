// 规则/模式定时器到点处理（L4）：实现 trigger_timer 端口的 handler 半边。
//
// 方案 §5.5/§5.10：
// - TimerManager.task() 识别 ruleId 条目后不再按旧语义消费，只调 owns()/fire()；
// - 生命周期（一次性移除、interval 递减续期、规则被删则清理）由本模块负责；
// - 规则 fire 复用 runChain(sourceSatisfied=true)，保证与消息/事件入口同一求值/起轮路径；
// - 隐式模式 timer（mode:<sid>）不建规则，直接按 prompts 起轮。
import { getSessionById } from "../core/ports/session_lookup";
import { addRuleTimer, listRuleTimers, removeRuleTimers, setTriggerTimerHandler } from "../core/ports/trigger_timer";
import { logger } from "../logger";
import type { TimerInfo } from "../timer";
import { applyLastMessageRef, getSessionCtxAndMsg } from "../utils/seal";
import { pickPrompt } from "../utils/timer_spec";

import { DEFAULT_RULE_WAKE_TEXT, getRuleStore, runChain } from "./trigger_rule";
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

/**
 * 续期/消费一条规则定时器：
 * - 先移除此规则的所有条目（规则同一时间只有一条 timer）；
 * - interval 且还有剩余次数：按原间隔续期（count 减 1）；
 * - 否则彻底移除。
 */
function advanceTimer(timer: TimerInfo, consumed: boolean): void {
    const ruleId = timer.ruleId || '';
    removeRuleTimers(ruleId);
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
        removeRuleTimers(ruleId);
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
