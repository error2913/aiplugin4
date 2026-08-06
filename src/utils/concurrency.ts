// 请求并发限制：全局信号量 + 等待队列（超出并发上限进队列，队列满直接丢弃）
import Config from "../config/config";
import { logger } from "../logger";

const LOG_COOLDOWN_MS = 10000;

const lastLogTime: { [key: string]: number } = {};

/** 同一类超限日志在冷却时间内只提示一次，避免刷屏 */
function logOnce(key: string, level: 'warning' | 'error', message: string): void {
    const now = Date.now();
    if (now - (lastLogTime[key] || 0) < LOG_COOLDOWN_MS) return;
    lastLogTime[key] = now;
    if (level === 'warning') logger.warning(message);
    else logger.error(message);
}

class RequestLimiter {
    private active = 0;
    private queue: Array<() => void> = [];

    /** 获取请求许可；超出并发上限时进入队列等待，队列满返回 false（请求被丢弃） */
    async acquire(): Promise<boolean> {
        const maxConcurrent = Config.base.REQUEST_CONCURRENCY;
        if (maxConcurrent <= 0) return true;

        if (this.active < maxConcurrent) {
            this.active++;
            return true;
        }

        const maxQueue = Config.base.REQUEST_QUEUE;
        if (this.queue.length >= maxQueue) {
            logOnce('request-queue-full', 'error', `请求队列已满（上限 ${maxQueue}），请求被丢弃`);
            return false;
        }

        logOnce('request-queued', 'warning', `请求超过并发上限（${maxConcurrent}），已加入队列等待`);
        return new Promise<boolean>(resolve => {
            this.queue.push(() => resolve(true));
        });
    }

    /** 释放请求许可并唤醒队列中下一个等待者 */
    release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
        } else {
            this.active = Math.max(0, this.active - 1);
        }
    }
}

export const requestLimiter = new RequestLimiter();
