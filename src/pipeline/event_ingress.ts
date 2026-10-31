// 事件入口（L4）：所有事件触发先走链规则（新），再由 v1 规则兜底（旧），二者共享同一事件去重。
//
// 方案 §5.6 / Q12：
// - 链 event 规则独立于「事件触发」开关（eventTrigger），但需要触发闸 aiEnabled；
// - 同一条事件最多一个触发对象：先用调用方 dedupKey 查 v1 去重表，再用认领表标记，防止链+v1 双发言；
// - 触发文本/起轮统一走 wake（trigger_rule → wakeSession）。
import { getSessionById } from "../core/ports/session_lookup";
import { EVENT_TRIGGER_KNOWN_EVENTS, isEventTriggerExcluded } from "../event/trigger";
import type { EventView } from "../event/trigger";
import { logger } from "../logger";
import type { Session } from "../session/session";
import { SYSTEM_NAME } from "../utils/protocol";
import { applyLastMessageRef, getSessionCtxAndMsg } from "../utils/seal";

import { claimTable, eventClaimKey } from "./claim_table";
import type { TriggerEventOptions } from "./event_trigger";
import { getRuleStore, runChainForEvent } from "./trigger_rule";



const log = logger.withTag('event-ingress');

/** 是否存在可用的链事件规则（供调用方提前短路） */
export function hasChainEventRules(): boolean {
    return getRuleStore().list().some(rule => rule.enabled && rule.gates[0]?.type === 'event' && EVENT_TRIGGER_KNOWN_EVENTS.includes(rule.gates[0].on as never));
}

/**
 * 尝试用链规则处理事件。返回 true 表示已触发/已挂起/已认领（调用方应停止后续 v1 判定）。
 */
export async function tryChainEventTrigger(view: EventView, dedupKey: string, options: TriggerEventOptions = {}): Promise<boolean> {
    try {
        if (!hasChainEventRules()) return false;
        if (isEventTriggerExcluded(view)) return false;
        const claimKey = eventClaimKey(dedupKey);
        if (claimTable.hasClaim(view.sid, claimKey)) return true;

        const session: Session | undefined = options.session ?? getSessionById(view.sid);
        // 触发闸（方案 C3）：GLOBAL_STANDBY 只放开录制，不放开触发
        if (!session.setting.enabled()) return false;
        let ctx = options.ctx;
        let msg = options.msg;
        if (!ctx || !msg) {
            try {
                ({ ctx, msg } = getSessionCtxAndMsg(view.epId, view.sid, view.isPrivate));
                applyLastMessageRef(session, ctx, msg);
            } catch (e) {
                log.debug(`链事件跳过：无法重建会话上下文 ${view.sid}（${e instanceof Error ? e.message : String(e)}）`);
                return false;
            }
        }
        // 空闲：求值后异步起轮（detached，不阻塞 ob11 分发）；
        // 忙：只求值，命中后把唤醒文本挂进 pendingQueue（轮末 resumePending 补一轮）。
        const busy = session.running || session.starting;
        const result = busy
            ? await runChainForEvent(session, view, ctx, msg, { deferWake: true })
            : await runChainForEvent(session, view, ctx, msg, { detachedWake: true });
        if (result.status === 'no-match' || result.status === 'claimed') return false;
        claimTable.claim(view.sid, claimKey, 'chain');
        if (busy && result.status === 'parked') {
            await session.deferReceipt(ctx, msg, options.messageArray ?? [], 'trigger', result.wakeText, SYSTEM_NAME.triggerRule);
            session.savePending();
            log.info(`事件触发挂起（会话忙）：${view.eventType} sid=${view.sid}`);
        }
        return true;
    } catch (e) {
        log.warning(`链事件触发失败（已忽略）：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}
