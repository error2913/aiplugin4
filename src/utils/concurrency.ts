// 请求并发限制：全局信号量 + 等待队列（超出并发上限进队列，队列满直接丢弃）
import Config from "../config/config";
import { logger } from "../logger";

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
            logger.error(`请求达到并发上限（${maxConcurrent}）且队列已满（上限 ${maxQueue}），请求被丢弃`);
            return false;
        }

        logger.warning(`请求达到并发上限（${maxConcurrent}），已加入队列等待（队列 ${this.queue.length + 1}/${maxQueue}）`);
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
