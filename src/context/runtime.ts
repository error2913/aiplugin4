// 上下文运行时状态（WeakMap，不进会话存档）：入库串行化链 + 归档连续失败计数 + 结算失败计数。
// 放独立叶子模块，供 context.ts 与 context/archiver.ts 共用（避免 archiver ↔ context 循环依赖）。
export interface ContextRuntime {
    ingestChain: Promise<void>;
    archiveFailCount: number;
    settleFailCount?: number;
}

const contextRuntime = new WeakMap<object, ContextRuntime>();

export function runtimeOf(ctx: object): ContextRuntime {
    let rt = contextRuntime.get(ctx);
    if (!rt) {
        rt = { ingestChain: Promise.resolve(), archiveFailCount: 0, settleFailCount: 0 };
        contextRuntime.set(ctx, rt);
    }
    return rt;
}

/** 归档连续失败达到该次数后，允许一次"降级丢弃最早轮次"兜底，避免长会话永久无法回复 */
export const ARCHIVE_FAIL_LIMIT = 3;
