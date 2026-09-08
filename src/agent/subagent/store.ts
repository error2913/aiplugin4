// 子代理持久化：KV 接口上的 ChildRecord 索引 + child 会话载荷存取。
// 默认存储键：subagent_index:<parent>（记录数组）、session_sub:<parent>:<child>（会话载荷）。
// 不依赖 seal，KV 由对接层注入（运行期用 ext.storageGet/Set，测试用内存 Map）。
import type { ChildRecord } from './types';

export interface KvLike {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export const indexKey = (parentSessionId: string): string => `subagent_index:${parentSessionId}`;
export const seqKey = (parentSessionId: string): string => `subagent_seq:${parentSessionId}`;
export const rootKey = 'subagent:roots';
export const childSessionKey = (parentSessionId: string, childId: string): string =>
    `session_sub:${parentSessionId}:${childId}`;

export interface SubAgentStoreOptions {
    /** 每父会话记录保留上限（自动清理最旧已结束记录；运行中不清理）。默认 100 */
    retention?: number;
}

export class SubAgentStore {
    private readonly kv: KvLike;
    private readonly retention: number;

    constructor(kv: KvLike, opts: SubAgentStoreOptions = {}) {
        this.kv = kv;
        this.retention = opts.retention ?? 100;
    }

    private readIndex(parentSessionId: string): ChildRecord[] {
        const raw = this.kv.get(indexKey(parentSessionId));
        if (raw === null || raw === '') return [];
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr as ChildRecord[];
        } catch {
            // 损坏的索引直接重置，避免整条父会话记录不可用
            return [];
        }
    }

    private writeIndex(parentSessionId: string, records: ChildRecord[]): void {
        this.kv.set(indexKey(parentSessionId), JSON.stringify(records));
    }

    /** 本父会话下一个 child 序号（按现存记录尾部推导；仅读取用） */
    nextSeq(parentSessionId: string): number {
        const records = this.readIndex(parentSessionId);
        let max = 0;
        for (const r of records) {
            const tail = r.childId.slice(r.childId.lastIndexOf(':') + 1);
            const n = Number(tail);
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max + 1;
    }

    /** 分配序号：独立单调计数器，删除记录不回退（保证 childId 不被复用） */
    allocateSeq(parentSessionId: string): number {
        const raw = this.kv.get(seqKey(parentSessionId));
        let n = 0;
        if (raw !== null && raw !== '') {
            const parsed = Number(raw);
            if (Number.isFinite(parsed) && parsed >= 0) n = parsed;
        }
        n++;
        this.kv.set(seqKey(parentSessionId), String(n));
        this.touchRoot(parentSessionId);
        return n;
    }

    // —— 根索引（重载清扫/对账用）——
    listRoots(): string[] {
        const raw = this.kv.get(rootKey);
        if (raw === null || raw === '') return [];
        try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    private touchRoot(parentSessionId: string): void {
        const roots = this.listRoots();
        if (roots.includes(parentSessionId)) return;
        roots.push(parentSessionId);
        this.kv.set(rootKey, JSON.stringify(roots));
    }

    list(parentSessionId: string): ChildRecord[] {
        return this.readIndex(parentSessionId).slice().sort((a, b) => a.createdAt - b.createdAt);
    }

    get(parentSessionId: string, childId: string): ChildRecord | null {
        const records = this.readIndex(parentSessionId);
        const found = records.find(r => r.childId === childId);
        return found ? { ...found, inbox: found.inbox ? found.inbox.slice() : [] } : null;
    }

    upsert(parentSessionId: string, record: ChildRecord): void {
        const records = this.readIndex(parentSessionId);
        const idx = records.findIndex(r => r.childId === record.childId);
        if (idx >= 0) records[idx] = record; else records.push(record);
        this.writeIndex(parentSessionId, this.trimDone(records));
    }

    remove(parentSessionId: string, childId: string): boolean {
        const records = this.readIndex(parentSessionId);
        const next = records.filter(r => r.childId !== childId);
        if (next.length === records.length) return false;
        this.writeIndex(parentSessionId, next);
        return true;
    }

    /** 清理最旧已结束（done/stopped）记录到保留上限；返回清理条数 */
    trim(parentSessionId: string): number {
        const records = this.readIndex(parentSessionId);
        const next = this.trimDone(records);
        if (next.length === records.length) return 0;
        this.writeIndex(parentSessionId, next);
        return records.length - next.length;
    }

    private trimDone(records: ChildRecord[]): ChildRecord[] {
        if (this.retention <= 0 || records.length <= this.retention) return records;
        const alive: ChildRecord[] = [];
        const done: ChildRecord[] = [];
        for (const r of records) {
            if (r.status === 'running' || r.status === 'idle') alive.push(r); else done.push(r);
        }
        done.sort((a, b) => a.createdAt - b.createdAt);
        const overflow = records.length - this.retention;
        const drop = done.splice(0, Math.min(done.length, overflow));
        void drop;
        return alive.concat(done).sort((a, b) => a.createdAt - b.createdAt);
    }

    // —— child 会话载荷（完整 Session 由对接层序列化后存取）——
    saveChildSession(parentSessionId: string, childId: string, payload: unknown): void {
        this.kv.set(childSessionKey(parentSessionId, childId), JSON.stringify(payload));
    }

    loadChildSession<T>(parentSessionId: string, childId: string): T | null {
        const raw = this.kv.get(childSessionKey(parentSessionId, childId));
        if (raw === null || raw === '') return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }

    removeChildSession(parentSessionId: string, childId: string): void {
        this.kv.set(childSessionKey(parentSessionId, childId), '');
    }
}

/** 内存 KV（单测 / 无 seal 环境） */
export class MemoryKv implements KvLike {
    private readonly map = new Map<string, string>();
    get(key: string): string | null {
        const v = this.map.get(key);
        return v === undefined || v === '' ? null : v;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
    dump(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of this.map) out[k] = v;
        return out;
    }
}
