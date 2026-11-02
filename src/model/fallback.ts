// 备用模型选择（纯函数）：从当前模型在有序候选里**只向后**取下一个。
//
// 为什么不是"取第一个不等于当前的"（历史踩坑）：当前模型若不是列表首位，
// 那个写法会绕回开头 —— A→B 之后 B 失败又切回 A，在两个模型间来回跳。
// 走到末尾返回 null，而不是重试已经失败过的。
//
// 从 `agent.ts` 迁出：memory scheduler / aux breaker 也要用，而 agent 与
// memory_scheduler 互相 import 会成环（deps 基线 maxCycle=0）。
import type { ModelEntry } from "./entry";

/**
 * @param pool 已按用户 purposes 顺序排好的候选
 * @param strategy 'cross' 时优先挑不同 provider 的（避开整家厂商故障）
 */
export function pickNextModel(
    pool: ModelEntry[],
    current: ModelEntry | null,
    strategy: 'cross' | 'order',
): ModelEntry | null {
    if (pool.length === 0) return null;
    const idx = current ? pool.findIndex(c => c.ref === current.ref) : -1;
    const forward = idx >= 0 ? pool.slice(idx + 1) : pool;
    if (forward.length === 0) return null;
    if (strategy === 'cross' && current) {
        const cross = forward.find(c => c.provider !== current.provider);
        if (cross) return cross;
    }
    return forward[0];
}
