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

/**
 * 带截止时间的 Promise 包装：settle 后清掉定时器（goja 的 setTimeout 返回数字 id）。
 *
 * 注意：**这不是取消**。goja 没有 AbortController，超时只让调用方不再等待；
 * 底层 Go 的 HTTP 请求可能仍在后台跑完，body 内存晚于超时释放。
 * 因此图片下载的内存安全靠 `maxBytes` 上限与并发闸门（resource/image_fetch.ts），不能靠超时回收。
 *
 * 与 withTimeout 的区别：withTimeout 的 stopEvent 分支会清 timer，但无 stopEvent 分支
 * （Promise.race）成功/失败都不清；本函数两条路径都清，且超时错误带 code='TIMEOUT' 便于区分。
 */
export function withDeadline<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: any = null;
        const finish = () => {
            if (timer !== null) {
                try { clearTimeout(timer); } catch (_e) { /* 忽略：清理失败不影响结果 */ }
                timer = null;
            }
        };
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            finish();
            const err: any = new Error(`操作超时 (${timeoutMs}ms)`);
            err.code = 'TIMEOUT';
            reject(err);
        }, timeoutMs);
        let promise: Promise<T>;
        try {
            promise = fn();
        } catch (e) {
            // fn 同步抛错：先清 timer 再 reject，否则 timer 泄漏（本方案里 fn 都是 async，属防御）
            settled = true;
            finish();
            reject(e);
            return;
        }
        promise.then(
            value => {
                if (settled) return;
                settled = true;
                finish();
                resolve(value);
            },
            error => {
                if (settled) return;
                settled = true;
                finish();
                reject(error);
            },
        );
    });
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
