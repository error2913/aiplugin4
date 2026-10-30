// timer 单模式注册（L3）：把全局「默认定时器」TOML 的多个 [[timer]] 落成每个会话的隐式定时器。
//
// 方案 §5.5：timer 模式是"configured"模式——开关按会话（Setting.timerTrigger），
// 参数唯一来自全局 TOML；每个 [[timer]] 一个定时器，ruleId = `mode:<sid>`，
// 由 trigger_timer 端口的 handler 到点 wake（隐式 mode timer 直接起轮）。
import Config from "../config/config";
import { addRuleTimer, removeRuleTimers } from "../core/ports/trigger_timer";
import { logger } from "../logger";

import type { Session } from "./session";

const log = logger.withTag('mode-timer');

/** 该会话的模式 timer 标识（删除/续期都以它为单位） */
export function modeTimerRuleId(sessionId: string): string {
    return `mode:${sessionId}`;
}

/**
 * 同步某会话的 timer 模式定时器：
 * - 关闭：移除全部 mode:<sid> 定时器；
 * - 开启且 TOML 有效：先移除旧的，再按每个 [[timer]] 注册一个；
 * - TOML 整份非法：保持关闭并报错（命令侧应拒绝开启）。
 * @returns 实际注册的定时器数量（关闭/失败为 0）
 */
export function syncModeTimers(session: Pick<Session, 'sessionId' | 'setting'>): number {
    const ruleId = modeTimerRuleId(session.sessionId);
    removeRuleTimers(ruleId);
    if (!session.setting.timerTrigger) return 0;
    const config = Config.trigger.TIMER_SPECS;
    if (!config.VALID) {
        log.error('「默认定时器」TOML 非法，timer 模式不生效；请修正配置后重载 JS');
        return 0;
    }
    if (config.SPECS.length === 0) {
        log.warning('「默认定时器」为空，timer 模式已开启但不会触发');
        return 0;
    }
    // 会话的 epId/isPrivate 从最近上下文取；取不到则用会话 id 兜底（私聊/群皆可解析）
    const ctx = (session as Pick<Session, 'sessionId' | 'setting'> & { lastCtx?: seal.MsgContext | null }).lastCtx;
    const epId = ctx?.endPoint?.userId || session.sessionId;
    const isPrivate = !!ctx?.isPrivate;
    for (const spec of config.SPECS) {
        if (spec.types === 'target') {
            addRuleTimer({ sid: session.sessionId, isPrivate, epId }, {
                ruleId,
                modeTag: 'mode',
                type: 'target',
                target: spec.targetAt || 0,
                count: 1,
                prompts: spec.prompts,
            });
        } else {
            addRuleTimer({ sid: session.sessionId, isPrivate, epId }, {
                ruleId,
                modeTag: 'mode',
                type: 'interval',
                interval: spec.intervalSec || 60,
                count: spec.count,
                prompts: spec.prompts,
            });
        }
    }
    log.info(`timer 模式已注册 ${config.SPECS.length} 个定时器（${session.sessionId}）`);
    return config.SPECS.length;
}
