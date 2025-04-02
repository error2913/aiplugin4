import { log } from "../utils/utils";

export class ReadWriteLock {
    private readers = 0; // 当前持有读锁的线程数量
    private writers = 0; // 当前持有写锁的线程数量
    private waitQueue: Array<() => void> = []; // 等待队列

    async acquireReadLock() {
        return new Promise<void>((resolve) => {
            if (this.writers > 0) {
                log(`等待读锁释放，当前读锁数量：${this.readers}，写锁数量：${this.writers}，等待队列长度：${this.waitQueue.length}`);
                this.waitQueue.push(resolve);
            } else {
                this.readers++;
                resolve();
            }
        });
    }
    releaseReadLock() {
        this.readers--;
        this.notifyNext();
    }

    async acquireWriteLock() {
        return new Promise<void>((resolve) => {
            if (this.readers > 0 || this.writers > 0) {
                log(`等待写锁释放，当前读锁数量：${this.readers}，写锁数量：${this.writers}，等待队列长度：${this.waitQueue.length}`);
                this.waitQueue.push(resolve);
            } else {
                this.writers++;
                resolve();
            }
        });
    }
    releaseWriteLock() {
        this.writers--;
        this.notifyNext();
    }

    private notifyNext() {
        if (this.waitQueue.length > 0) {
            const next = this.waitQueue.shift();
            next?.();
        }
    }
}