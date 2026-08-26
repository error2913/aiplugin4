// 请求并发限制：全局信号量 + 等待队列（超出并发上限进队列，队列满直接丢弃）
import Config from "../config/config";
import { logger } from "../logger";

interface QueueEntry {
    /** 归属会话，供 .ai stop 精准清理排队请求 */
    sessionId: string;
    resolve: (value: boolean) => void;
}

class RequestLimiter {
    private active = 0;
    private queue: QueueEntry[] = [];

    /** 获取请求许可；超出并发上限时进入队列等待，队列满返回 false（请求被丢弃）；sessionId 用于 stop 时清理本会话排队项 */
    async acquire(sessionId: string = ''): Promise<boolean> {
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
            this.queue.push({ sessionId, resolve });
        });
    }

    /** 释放请求许可并唤醒队列中下一个等待者 */
    release(): void {
        const next = this.queue.shift();
        if (next) {
            next.resolve(true);
        } else {
            this.active = Math.max(0, this.active - 1);
        }
    }

    /** 取消指定会话的排队请求：resolve(false) 使 run/runStream 直接返回，返回取消数量 */
    cancelBySession(sessionId: string): number {
        let count = 0;
        for (let i = this.queue.length - 1; i >= 0; i--) {
            if (this.queue[i].sessionId === sessionId) {
                const [entry] = this.queue.splice(i, 1);
                entry.resolve(false);
                count++;
            }
        }
        if (count > 0) {
            logger.warning(`取消会话<${sessionId}>的排队请求 ${count} 条`);
        }
        return count;
    }
}

export const requestLimiter = new RequestLimiter();
