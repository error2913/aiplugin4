// 停止事件与超时控制（叶子模块）：纯控制流工具，不依赖 Config/业务模块。
// 从 utils/utils.ts 拆出的原因：工具执行器、模型请求等底层模块只需要它们，
// 若经 utils/utils 取会把这些模块拉进 utils/transport/tool 的依赖环（见 deps:check）。
export interface StopEvent {
    fired: boolean;
    waiters: Array<() => void>;
}

/** 因会话 stop 而中止运行的控制流异常：各层捕获后静默返回，不打印堆栈 */
export class StopError extends Error {
    constructor() {
        super('会话已停止');
        this.name = 'StopError';
    }
}

export function createStopEvent(): StopEvent {
    return { fired: false, waiters: [] };
}

/** 触发停止信号：置 fired 并同步唤醒全部等待者（goja 单线程，唤醒在 stop 调用栈内同步执行） */
export function fireStopEvent(ev: StopEvent): void {
    ev.fired = true;
    const waiters = ev.waiters;
    ev.waiters = [];
    for (const w of waiters) {
        try {
            w();
        } catch (_e) {
            // 等待者回调只做 reject，兜底吞掉避免 stop 流程被异常打断
        }
    }
}

/** 重置停止信号：新一轮 run 启动且通过代际检查后调用（同会话单 run 闸门保证此时无在跑的 waiters） */
export function resetStopEvent(ev: StopEvent): void {
    ev.fired = false;
    ev.waiters = [];
}

export function withTimeout<T>(asyncFunc: () => Promise<T>, timeoutMs: number, opts?: { stopEvent?: StopEvent }): Promise<T> {
    const { stopEvent } = opts ?? {};
    if (!stopEvent) {
        return Promise.race([
            asyncFunc(),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
            })
        ]);
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: number | null = null;
        const waiter = () => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            reject(new StopError());
        };
        if (stopEvent.fired) {
            reject(new StopError());
            return;
        }
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const idx = stopEvent.waiters.indexOf(waiter);
            if (idx !== -1) stopEvent.waiters.splice(idx, 1);
            reject(new Error(`操作超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        stopEvent.waiters.push(waiter);
        asyncFunc().then(
            value => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                const idx = stopEvent.waiters.indexOf(waiter);
                if (idx !== -1) stopEvent.waiters.splice(idx, 1);
                resolve(value);
            },
            error => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                const idx = stopEvent.waiters.indexOf(waiter);
                if (idx !== -1) stopEvent.waiters.splice(idx, 1);
                reject(error);
            }
        );
    });
}
