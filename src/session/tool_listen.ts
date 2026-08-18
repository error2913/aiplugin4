import { ToolListen } from "../tool/types";

interface ToolWaiter {
    resolve: (messages: string[]) => void;
    reject: (error: Error) => void;
    messages: string[];
    settleTimer: any;
    timeoutTimer: any;
    maxMessages: number;
    settleMs: number;
}

/** 创建不参与会话持久化的运行时消息监听器。 */
export function createToolListen(): ToolListen {
    const waiters: ToolWaiter[] = [];
    const dispatch = (content: string): void => {
        for (let i = waiters.length - 1; i >= 0; i--) {
            const waiter = waiters[i];
            if (waiter.messages.length < waiter.maxMessages) waiter.messages.push(content);
            if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
            if (waiter.messages.length >= waiter.maxMessages) {
                waiters.splice(i, 1);
                clearTimeout(waiter.timeoutTimer);
                waiter.resolve(waiter.messages);
                continue;
            }
            waiter.settleTimer = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                clearTimeout(waiter.timeoutTimer);
                waiter.resolve(waiter.messages);
            }, waiter.settleMs);
        }
    };
    const rejectAll = (error: Error): void => {
        while (waiters.length) {
            const waiter = waiters.shift()!;
            clearTimeout(waiter.settleTimer);
            clearTimeout(waiter.timeoutTimer);
            waiter.reject(error);
        }
    };
    const listen: ToolListen = {
        timeoutId: null,
        resolve: dispatch,
        reject: rejectAll,
        cleanup: () => {
            if (listen.timeoutId) clearTimeout(listen.timeoutId);
            listen.timeoutId = null;
            rejectAll(new Error('监听已清理'));
            // cleanup 后恢复当前监听器的分发入口。
            listen.resolve = dispatch;
            listen.reject = rejectAll;
        },
        push: dispatch,
        waitFor: (timeoutMs = 10000, settleMs = 400, maxMessages = 20) => new Promise((resolve, reject) => {
            const waiter: ToolWaiter = {
                resolve,
                reject,
                messages: [],
                settleTimer: null,
                timeoutTimer: null,
                maxMessages: Math.max(1, maxMessages),
                settleMs: Math.max(0, settleMs),
            };
            waiter.timeoutTimer = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                resolve(waiter.messages);
            }, Math.max(1, timeoutMs));
            waiters.push(waiter);
        }),
    };
    return listen;
}
