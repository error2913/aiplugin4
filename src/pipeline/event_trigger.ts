// 事件触发编排（L4）：规则匹配 → 已触发标记 → 忙时挂起（复用 pendingQueue）/ 空闲写提示并起一轮。
//
// 语义（见 .dev/issue-147-event-trigger-plan.md）：
// - 事件已由 pipeline/events 按现有接收链路录进上下文，这里只负责"是否触发"；
// - 不新增队列：忙时把触发提示挂进 session.pendingQueue（kind:'trigger'），由 flushPending/resumePending 处理；
// - 不新增限流；同会话靠 running/starting 串行；
// - 绝不 await AI（ob11 依赖"串行"分发下会阻塞后续所有事件），chat 一律 fire-and-forget。
import Config from "../config/config";
import { isEventTriggered, markEventTriggered } from "../event/notice";
import {
    type EventTriggerRule,
    type EventView,
    isEventTriggerExcluded,
    matchEventTrigger,
    renderTriggerPrompt,
} from "../event/trigger";
import { logger } from "../logger";
import { eventTriggerInstruction } from "../prompt/texts/en";
import type { Session } from "../session/session";
import { getSession } from "../session/session_service";
import { SYSTEM_NAME } from "../utils/protocol";
import { getSessionCtxAndMsg } from "../utils/seal";
import type { MessageSegment } from "../utils/string";

const log = logger.withTag('event-trigger');

/** poke 单路径：同一毫秒的重复回调用短窗口挡住，正常连戳不受影响 */
const POKE_TRIGGER_WINDOW_MS = 1500;

export interface TriggerEventOptions {
    /** 已取得/已加载的会话（poke 路径复用消息管线里的 session） */
    session?: Session;
    /** 已有 ctx/msg（poke 路径）；缺省时按 epId/sid 重建 */
    ctx?: seal.MsgContext;
    msg?: seal.Message;
    /** poke 路径传入原始消息段，用于触发前把 poke 内容部分正常入库 */
    messageArray?: MessageSegment[];
    /** ob11 poke 没有背景事件条目：把事件文本直接并进触发提示（native poke 已作为消息入库，不传） */
    injectEventText?: boolean;
}

/** 是否有可用的触发规则（供调用方提前短路，避免无谓的会话加载） */
export function hasEventTriggerRules(): boolean {
    const config = Config.trigger.EVENT_TRIGGER.CONFIG;
    return !!config && config.rules.length > 0;
}

/**
 * 尝试对一条已入库事件执行触发。返回 true 表示已触发（或已挂起），调用方应停止后续触发判定。
 * 内部吞掉所有异常：事件录制/普通对话不能因触发逻辑失败而受影响。
 */
export async function maybeTriggerEvent(view: EventView, dedupKey: string, options: TriggerEventOptions = {}): Promise<boolean> {
    try {
        const config = Config.trigger.EVENT_TRIGGER.CONFIG;
        if (!config || config.rules.length === 0) return false;
        if (isEventTriggerExcluded(view)) return false;

        const rule = matchEventTrigger(config.rules, view);
        if (!rule) return false;
        if (isEventTriggered(dedupKey)) return false;

        const session = options.session ?? getSession(view.sid);
        // 统一的 AI 开启门禁：未待机（含 .ai off）时不响应事件触发
        if (!(session.setting.standby || Config.base.GLOBAL_STANDBY)) return false;
        let ctx = options.ctx;
        let msg = options.msg;
        if (!ctx || !msg) {
            try {
                ({ ctx, msg } = getSessionCtxAndMsg(view.epId, view.sid, view.isPrivate));
            } catch (e) {
                log.debug(`事件触发跳过：无法重建会话上下文 ${view.sid}（${e instanceof Error ? e.message : String(e)}）`);
                return false;
            }
        }

        const instruction = renderTriggerPrompt(rule.prompt, view);
        const text = eventTriggerInstruction({
            instruction,
            eventText: options.injectEventText ? view.eventText : undefined,
        });
        markEventTriggered(dedupKey, view.source === 'poke' ? POKE_TRIGGER_WINDOW_MS : undefined);

        if (session.running || session.starting) {
            // 忙：只挂起触发提示；事件文本已由录制链路写入上下文，轮末 flush/resume 再起一轮。
            await session.deferReceipt(ctx, msg, options.messageArray ?? [], 'trigger', text, SYSTEM_NAME.eventTrigger);
            session.savePending();
            log.info(`事件触发已挂起（会话忙）：${view.eventType} sid=${view.sid}`);
            return true;
        }

        // 空闲：poke 路径先把 poke 内容部分正常入库（notice/request 已录制，无需重复写）。
        if (options.messageArray) await session.handleReceipt(ctx, msg, options.messageArray);
        await session.context.addSystemUserMessage(text, SYSTEM_NAME.eventTrigger, {
            eventType: view.eventType,
            ...(view.source === 'poke' && view.raw !== undefined ? { raw: view.raw } : {}),
        });
        session.save(true);
        void session.chat(ctx, msg, `事件触发:${rule.on}`).catch((e: any) => {
            log.exception('事件触发起轮出错', e);
        });
        log.info(`事件触发：${view.eventType} sid=${view.sid}`);
        return true;
    } catch (e) {
        log.exception('事件触发处理出错（已忽略，不影响事件录制）', e);
        return false;
    }
}

/** 暴露给单测：当前是否允许该事件触发（硬排除/规则为空） */
export function canTriggerEvent(view: EventView): boolean {
    const config = Config.trigger.EVENT_TRIGGER.CONFIG;
    if (!config || config.rules.length === 0) return false;
    if (isEventTriggerExcluded(view)) return false;
    return matchEventTrigger(config.rules, view) !== null;
}

export type { EventTriggerRule };
