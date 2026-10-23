// 会话节奏（纯函数）：冷热状态与活跃时间段计算。
// 从 session.ts 拆出——这些判定只依赖设定/在途标记/时间，不需要 Session 实例，
// 便于单测与「命令只读查询」语义复用（stateOf(now, { touch: false })）。

/** 冷热状态的时间窗（内置常量，见 docs/03 上下文模块）：待机且连续 **10 分钟**无相关活动才转冷 */
export const COLD_AFTER_MS = 10 * 60 * 1000;               // 冷态进入阈值：10 分钟
export const COOL_DOWN_MS = 60_000;                        // 转冷前的余温过渡带（1 分钟）
export const HOT_HOLD_MS = COLD_AFTER_MS - COOL_DOWN_MS;   // 热态保持 = 9 分钟

export type SessionTemperature = 'HOT' | 'COOLING' | 'COLD';

export interface TemperatureInput {
    /** 本会话 standby 或全局 GLOBAL_STANDBY */
    standby: boolean;
    /** running / starting / activeRuns > 0 */
    busy: boolean;
    lastRelevantAt: number;
    now: number;
}

/**
 * 冷热状态：**算出来的**，不持久化（重载后回默认＝回冷态，安全）。
 * - HOT：非待机（正常对话模式）／有在途任务／距上次相关活动 < 热态保持
 * - COOLING：距上次相关活动 ≥ 热态保持且 < 热态保持 + 冷态回落
 * - COLD：再往后（入库零 LLM、窗口按冷态窗口字数折叠）
 * "相关活动"＝任何一次 `session.chat()`（@/触发命中/结果送达/定时任务都走它）；普通群消息入库不算。
 *
 * @param touch 有在途任务时是否刷新 lastRelevantAt；只读查询必须传 false，
 *   否则命令本身会把会话"续命"成 HOT，使 COLD 永远无法被观察到（命令副作用）。
 * @returns state 与（可能被 touch 刷新的）lastRelevantAt，由调用方决定是否写回。
 */
export function computeSessionState(input: TemperatureInput, touch = true): { state: SessionTemperature; lastRelevantAt: number } {
    let lastRelevantAt = input.lastRelevantAt;
    if (!input.standby) return { state: 'HOT', lastRelevantAt };
    if (input.busy) {
        if (touch) lastRelevantAt = input.now;
        return { state: 'HOT', lastRelevantAt };
    }
    const idle = Math.max(0, input.now - lastRelevantAt);   // 防时钟回拨
    if (idle < HOT_HOLD_MS) return { state: 'HOT', lastRelevantAt };
    if (idle < HOT_HOLD_MS + COOL_DOWN_MS) return { state: 'COOLING', lastRelevantAt };
    return { state: 'COLD', lastRelevantAt };
}

export interface ActiveTimeInfo {
    start: number;
    end: number;
    segs: number;
}

/** 当前时间落在活跃时段的第几段；不在活跃时段返回 -1。 */
export function activeTimeSegmentIndex(info: ActiveTimeInfo, now: Date = new Date()): number {
    const cur = now.getHours() * 60 + now.getMinutes();
    const { start, end, segs } = info;
    if (segs <= 0) return -1;
    const endReal = end >= start ? end : end + 24 * 60;
    const curReal = cur >= start ? cur : cur + 24 * 60;

    if (curReal >= endReal) return -1;

    const segLen = (endReal - start) / segs;
    const index = Math.floor((curReal - start) / segLen);
    return Math.min(index, segs - 1);
}

/** 下一活跃时段点的 Unix 秒（带随机落到段内），无活跃时段返回 -1。 */
export function nextActiveTimePoint(info: ActiveTimeInfo, curSegIndex: number, nowMs: number = Date.now()): number {
    const { start, end, segs } = info;

    if (start === 0 && end === 0) return -1;
    if (segs <= 0) return -1;

    const endReal = end >= start ? end : end + 24 * 60;
    const segLen = (endReal - start) / segs;
    const nextSegIndex = (curSegIndex + 1) % segs;
    const todayMin = Math.floor(start + nextSegIndex * segLen + Math.random() * segLen) % (24 * 60);

    const nextTime = new Date(nowMs);
    nextTime.setHours(Math.floor(todayMin / 60), todayMin % 60, Math.floor(Math.random() * 60), 0);

    if (nextTime.getTime() <= nowMs) {
        nextTime.setDate(nextTime.getDate() + 1);
    }

    return Math.floor(nextTime.getTime() / 1000);
}
