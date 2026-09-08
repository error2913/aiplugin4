// 子代理结算后的父侧唤醒决策（纯函数，可单测）。
// 口径（docs/12 §2/§4.5）：notice 存在 + 父空闲 + 会话与全局均未待机 → 唤醒；
// 否则入队留待下次触发。令牌桶由调用方在真正 chat 时自然执行（空桶则本次不发言）。
export type WakeDecision = 'wake' | 'defer';

export interface WakeContext {
    /** 待结算 notice 数量 */
    noticeCount: number;
    /** 父会话当前是否有 run 在跑 */
    parentBusy: boolean;
    /** 会话级待机（setting.standby） */
    sessionStandby: boolean;
    /** 全局待机（Config 是否开启全局待机） */
    globalStandby: boolean;
}

export function decideWake(ctx: WakeContext): WakeDecision {
    if (ctx.noticeCount <= 0) return 'defer';
    if (ctx.parentBusy) return 'defer'; // 父在跑：notice 由下一轮 flushNotices 呈现
    if (ctx.sessionStandby || ctx.globalStandby) return 'defer';
    return 'wake';
}

/** 唤醒时合成触发的原因文本（对齐 session.chat 的 reason 入参） */
export const WAKE_REASON = '子代理完成通知';
