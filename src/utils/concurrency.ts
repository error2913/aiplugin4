// 请求并发限制：全局信号量 + 等待队列（超出并发上限进队列，队列满直接丢弃）
import Config from "../config/config";
import { logger } from "../logger";

interface QueueEntry {
    /** 归属会话，供 .ai stop 精准清理排队请求 */
    sessionId: string;
    resolve: (value: boolean) => void;
}

/** 活跃请求归属登记：每个并发槽记录当前占用它的会话，供状态查询按会话统计 */
interface ActiveEntry {
    sessionId: string;
}

class RequestLimiter {
    private activeEntries: ActiveEntry[] = [];
    private queue: QueueEntry[] = [];

    /** 获取请求许可；超出并发上限时进入队列等待，队列满返回 false（请求被丢弃）；sessionId 用于 stop 时清理本会话排队项 */
    async acquire(sessionId: string = ''): Promise<boolean> {
        const maxConcurrent = Config.base.REQUEST_CONCURRENCY;
        if (maxConcurrent <= 0) return true;

        if (this.activeEntries.length < maxConcurrent) {
            this.activeEntries.push({ sessionId });
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

    /** 释放请求许可并唤醒队列中下一个等待者；队列交接时活跃槽直接转让给下一个会话 */
    release(sessionId: string = ''): void {
        const next = this.queue.shift();
        if (next) {
            // 有排队者：活跃槽不归还，直接转让给下一个排队会话，并登记新会话归属
            const idx = this.activeEntries.findIndex(e => e.sessionId === sessionId);
            if (idx !== -1) {
                this.activeEntries[idx].sessionId = next.sessionId;
            } else {
                this.activeEntries.push({ sessionId: next.sessionId });
            }
            next.resolve(true);
        } else {
            // 无排队者：按归属精确归还活跃槽（同会话并发重叠时避免误减其他会话的槽）
            const idx = this.activeEntries.findIndex(e => e.sessionId === sessionId);
            if (idx !== -1) {
                this.activeEntries.splice(idx, 1);
            } else {
                // 兜底：找不到归属时移除最后一个活跃槽，保证许可最终归还
                this.activeEntries.pop();
            }
        }
    }

    /** 查询并发/排队统计；传 sessionId 时附带该会话的活跃与排队数量 */
    getQueueInfo(sessionId?: string): {
        active: number;
        activeBySession: number;
        queued: number;
        queuedBySession: number;
        maxConcurrent: number;
        maxQueue: number;
    } {
        return {
            active: this.activeEntries.length,
            activeBySession: sessionId ? this.activeEntries.filter(e => e.sessionId === sessionId).length : 0,
            queued: this.queue.length,
            queuedBySession: sessionId ? this.queue.filter(e => e.sessionId === sessionId).length : 0,
            maxConcurrent: Config.base.REQUEST_CONCURRENCY,
            maxQueue: Config.base.REQUEST_QUEUE
        };
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
