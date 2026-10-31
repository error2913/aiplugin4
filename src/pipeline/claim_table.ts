// 认领表（L4，编排胶水）：保证同一条消息/事件最多被一个触发对象处理。
//
// 为什么需要：链规则（含 delay 挂起）与判定去抖会同时盯上同一条消息；没有认领表时
// 两者各说一句（双发言）。认领只表达"谁处理了这条消息"，与起轮结果 ChatOutcome 是两层。
// 实现要点（方案 §5.2）：
// - 按 sid 分桶：不同群的 rawId 会撞键；
// - 条目带 TTL（默认 12s = 判定去抖上限），过期自动失效；
// - 纯内存、重载即丢（文档化）；无异步，无需加锁。
export type ClaimOwner = 'chain' | 'chain-pending' | 'mode';

/** 消息认领键：一条消息在会话内唯一 */
export function messageClaimKey(sessionId: string, rawId: string | number): string {
    return `msg:${sessionId}:${rawId}`;
}

/** 事件认领键（事件路径通常不参与消息认领，预留给 poke 等"消息化事件"） */
export function eventClaimKey(identity: string): string {
    return `evt:${identity}`;
}

export const CLAIM_TTL_MS = 12_000;

interface ClaimEntry {
    owner: ClaimOwner;
    until: number;
}

export class ClaimTable {
    private buckets = new Map<string, Map<string, ClaimEntry>>();
    private readonly ttlMs: number;
    private readonly now: () => number;

    constructor(options: { ttlMs?: number; now?: () => number } = {}) {
        this.ttlMs = options.ttlMs ?? CLAIM_TTL_MS;
        this.now = options.now || (() => Date.now());
    }

    /** 认领（同键重复认领只刷新 owner/TTL） */
    claim(sessionId: string, identity: string, owner: ClaimOwner): void {
        let bucket = this.buckets.get(sessionId);
        if (!bucket) {
            bucket = new Map();
            this.buckets.set(sessionId, bucket);
        }
        bucket.set(identity, { owner, until: this.now() + this.ttlMs });
    }

    release(sessionId: string, identity: string): boolean {
        const bucket = this.buckets.get(sessionId);
        if (!bucket) return false;
        const removed = bucket.delete(identity);
        if (bucket.size === 0) this.buckets.delete(sessionId);
        return removed;
    }

    /** 该消息是否已被认领（过期视为未认领） */
    hasClaim(sessionId: string, identity: string): boolean {
        const bucket = this.buckets.get(sessionId);
        if (!bucket) return false;
        const entry = bucket.get(identity);
        if (!entry) return false;
        if (entry.until <= this.now()) {
            bucket.delete(identity);
            if (bucket.size === 0) this.buckets.delete(sessionId);
            return false;
        }
        return true;
    }

    /** 会话内是否有任何未过期认领（WAIT 轮末/探针用） */
    hasClaimForSession(sessionId: string): boolean {
        const bucket = this.buckets.get(sessionId);
        if (!bucket) return false;
        const now = this.now();
        for (const [identity, entry] of [...bucket.entries()]) {
            if (entry.until <= now) bucket.delete(identity);
        }
        if (bucket.size === 0) {
            this.buckets.delete(sessionId);
            return false;
        }
        return true;
    }

    /** 取某消息的 owner（调试/日志用） */
    ownerOf(sessionId: string, identity: string): ClaimOwner | undefined {
        if (!this.hasClaim(sessionId, identity)) return undefined;
        return this.buckets.get(sessionId)?.get(identity)?.owner;
    }

    /** 清空某会话（`.ai stop`/会话销毁/LRU 淘汰） */
    releaseSession(sessionId: string): number {
        const bucket = this.buckets.get(sessionId);
        if (!bucket) return 0;
        const count = bucket.size;
        this.buckets.delete(sessionId);
        return count;
    }

    /** 清空全部（`.ai off`/重载） */
    clearAll(): number {
        let count = 0;
        for (const bucket of this.buckets.values()) count += bucket.size;
        this.buckets.clear();
        return count;
    }

    /** 清理过期条目（定时调用/测试用） */
    prune(): number {
        const now = this.now();
        let removed = 0;
        for (const [sessionId, bucket] of [...this.buckets.entries()]) {
            for (const [identity, entry] of [...bucket.entries()]) {
                if (entry.until <= now) {
                    bucket.delete(identity);
                    removed++;
                }
            }
            if (bucket.size === 0) this.buckets.delete(sessionId);
        }
        return removed;
    }

    get size(): number {
        let count = 0;
        for (const bucket of this.buckets.values()) count += bucket.size;
        return count;
    }
}

/** 全局单例（生产）；单测用 new ClaimTable({now}) 隔离 */
export const claimTable = new ClaimTable();
