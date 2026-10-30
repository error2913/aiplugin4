// 事件入口（L4）：所有事件触发先走链规则（新），再由 v1 规则兜底（旧），二者共享同一事件去重。
//
// 方案 §5.6 / Q12：
// - 链 event 规则独立于「事件触发」开关（eventTrigger），但需要录制门（aiEnabled || GLOBAL_STANDBY）；
// - 同一条事件最多一个触发对象：先用调用方 dedupKey 查 v1 去重表，再用认领表标记，防止链+v1 双发言；
// - 触发文本/起轮统一走 wake（trigger_rule → wakeSession）。
import Config from "../config/config";
import { getSessionById } from "../core/ports/session_lookup";
import { EVENT_TRIGGER_KNOWN_EVENTS, isEventTriggerExcluded } from "../event/trigger";
import type { EventView } from "../event/trigger";
import { logger } from "../logger";
import type { Session } from "../session/session";
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
        // 录制门（Q12）：链事件不需要 eventTrigger 开关，但仍要求 AI 未彻底关闭
        if (!session.setting.enabled() && !Config.base.GLOBAL_STANDBY) {
            return false;
        }
        if (session.running || session.starting) {
            // 忙：不在此处阻塞；交给 v1 路径的挂起语义或下一次事件（链规则挂起不丢会话提示，避免重复起轮）
            log.info(`事件触发挂起（会话忙）：${view.eventType} sid=${view.sid}`);
            return false;
        }
        let ctx = options.ctx;
        let msg = options.msg;
        if (!ctx || !msg) {
            ({ ctx, msg } = getSessionCtxAndMsg(view.epId, view.sid, view.isPrivate));
            applyLastMessageRef(session, ctx, msg);
        }
        const result = await runChainForEvent(session, view, ctx, msg);
        if (result.status === 'fired' || result.status === 'suspended' || result.status === 'gated' || result.status === 'bucket-empty' || result.status === 'deferred') {
            claimTable.claim(view.sid, claimKey, 'chain');
            return true;
        }
        return false;
    } catch (e) {
        log.warning(`链事件触发失败（已忽略）：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}
