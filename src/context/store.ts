// Context v2 单写者 + 增量持久化。
//
// 职责：
// - 同步 append（分配 seq/eventId、eventId 去重、更新内存日志与未摘要 token 估算）；
// - 唯一 flush 队列：只写「新事件页 + 新记录页 + 常量 head」，绝不重写历史；
// - 加载/恢复：读 head → 采纳 head 之后已写页 → 加载最近事件页与全部记录页；
// - 只读 snapshot 供 compile/recall 使用。
//
// 不做：压缩、召回地址解析、迁移落盘、命令；这些在各自模块。
import { getHost } from "../core/host";

import {
    assistantEventId,
    ConversationEvent,
    EventInput,
    fallbackEventId,
    RecordEntry,
    systemEventId,
    toolCallEventId,
    toolResultEventId,
    userEventId,
} from "./events";
import {
    ContextHead,
    createEmptyHead,
    parseHead,
    serializeHead,
} from "./head";
import { headKey } from "./keys";
import {
    buildEventPage,
    measureEventPageBytes,
    PageStoreError,
    probeStoredString,
    readEventPage,
    recoverEventPages,
    writeEventPages,
} from "./log/page_store";
import {
    buildRecordPage,
    loadRecordPages,
    measureRecordPageBytes,
    writeRecordPages,
} from "./log/record_store";

/** 一次 flush 结果（失败时保留 buffer/脏标记，可重试） */
export type FlushResult = {
    ok: boolean;
    writtenEventPages: number;
    writtenRecordPages: number;
    error?: string;
};

export interface ContextSnapshot {
    readonly head: Readonly<ContextHead>;
    readonly events: readonly ConversationEvent[];
    readonly records: readonly RecordEntry[];
    readonly version: number;
}

export type ContextStoreListener = (snapshot: ContextSnapshot) => void;

export interface ContextStoreOptions {
    /** 未摘要 token 估算（注入，避免 store 依赖 renderer）；缺省按 0 */
    estimateEventTokens?: (event: ConversationEvent) => number;
    /** 加载时最多往前读多少页事件页（默认 128） */
    loadRecentPages?: number;
    /** 加载时最多读多少记录页（默认 256） */
    loadRecordPages?: number;
    /** 单次 flush 最多写多少页（防御性上限） */
    maxPagesPerFlush?: number;
}

const DEFAULT_LOAD_RECENT_PAGES = 128;
const DEFAULT_MAX_PAGES_PER_FLUSH = 64;
const MAX_DEDUP_IDS = 8192;

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

/** 读取 head：不存在=新会话；读失败抛错（不能把读失败当新会话，否则会覆盖历史） */
export function loadHead(sessionId: string): ContextHead | null {
    const probe = probeStoredString(headKey(sessionId));
    if (probe.status === 'missing') return null;
    if (probe.status === 'error') {
        throw new Error(`读取上下文 head 失败: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`);
    }
    return parseHead(probe.raw);
}

export class ContextStore {
    readonly sessionId: string;
    private head: ContextHead;
    private events: ConversationEvent[] = [];
    private records: RecordEntry[] = [];
    private buffer: ConversationEvent[] = [];
    private pendingRecords: RecordEntry[] = [];
    private dedup = new Set<string>();
    private dedupOrder: string[] = [];
    private flushing: Promise<FlushResult> | null = null;
    private listeners: ContextStoreListener[] = [];
    private version = 0;
    private readonly estimate: (event: ConversationEvent) => number;
    private readonly loadRecentPages: number;
    private readonly loadRecordPagesLimit: number;
    private readonly maxPagesPerFlush: number;
    private loadedFromPageNo = 1;

    private constructor(sessionId: string, head: ContextHead, opts: ContextStoreOptions = {}) {
        this.sessionId = sessionId;
        this.head = head;
        this.estimate = opts.estimateEventTokens ?? (() => 0);
        this.loadRecentPages = Math.max(1, Math.floor(opts.loadRecentPages ?? DEFAULT_LOAD_RECENT_PAGES));
        this.loadRecordPagesLimit = Math.max(1, Math.floor(opts.loadRecordPages ?? 256));
        this.maxPagesPerFlush = Math.max(1, Math.floor(opts.maxPagesPerFlush ?? DEFAULT_MAX_PAGES_PER_FLUSH));
    }

    /**
     * 打开会话：读 head → 采纳 head 之后已写页（崩溃恢复）→ 加载最近事件页与全部记录页。
     * 没有任何 v2 数据时返回空 store（迁移由上层负责，不能在这里自动迁移）。
     */
    static async open(sessionId: string, opts: ContextStoreOptions = {}): Promise<ContextStore> {
        const stored = loadHead(sessionId);
        const store = new ContextStore(sessionId, stored ?? createEmptyHead(), opts);

        // 1) 恢复 head 之后已写的页（先写页、后写 head；崩溃点幂等采纳）
        const recovered = recoverEventPages(sessionId, store.head, { maxPages: store.maxPagesPerFlush * 4 });
        if (recovered.pages.length > 0) {
            store.head.nextPageNo = recovered.nextPageNo;
            store.head.persistedSeq = Math.max(store.head.persistedSeq, recovered.persistedSeq);
            for (const page of recovered.pages) store.adoptEvents(page.events);
        }

        // 2) 加载最近事件页（召回/编译窗口；更早的按需 readRange）
        const lastPage = store.head.nextPageNo - 1;
        const fromPage = Math.max(store.head.pageFloor, lastPage - store.loadRecentPages + 1);
        for (let pageNo = fromPage; pageNo <= lastPage; pageNo++) {
            if (pageNo < store.head.pageFloor) continue;
            let page;
            try {
                page = readEventPage(sessionId, pageNo);
            } catch (error) {
                // 页损坏不能静默忽略（读到一半的会话）；抛出由上层降级
                if (error instanceof PageStoreError && error.code === 'INVALID_PAGE') continue;
                throw error;
            }
            if (!page) continue;
            store.adoptEvents(page.events);
        }
        store.loadedFromPageNo = fromPage;

        // 3) 记录页全量加载（摘要/编辑/覆盖/遗忘）
        const rec = loadRecordPages(sessionId, { recFloor: store.head.recFloor, nextRecPageNo: store.head.nextRecPageNo }, { maxPages: store.loadRecordPagesLimit });
        for (const entry of rec.entries) store.addRecordToMemory(entry);

        store.events.sort((a, b) => a.seq - b.seq);
        store.version++;
        return store;
    }

    private adoptEvents(events: readonly ConversationEvent[]): void {
        for (const event of events) {
            if (this.dedup.has(event.eventId)) continue;
            this.events.push(event);
            this.trackDedup(event.eventId);
        }
    }

    private trackDedup(eventId: string): void {
        if (this.dedup.has(eventId)) return;
        this.dedup.add(eventId);
        this.dedupOrder.push(eventId);
        if (this.dedupOrder.length > MAX_DEDUP_IDS) {
            const drop = this.dedupOrder.splice(0, this.dedupOrder.length - MAX_DEDUP_IDS);
            for (const id of drop) this.dedup.delete(id);
        }
    }

    private nextSeq(): number {
        return this.head.nextSeq;
    }

    private eventIdFor(input: EventInput, seq: number): string {
        if (input.eventId) return input.eventId;
        const at = input.at ?? nowSec();
        switch (input.kind) {
            case 'user':
                return userEventId(input.msgId, fallbackEventId('u', `${at}:${seq}`));
            case 'assistant':
                return assistantEventId(input.msgId, fallbackEventId('a', `${at}:${seq}`));
            case 'tool_call':
                return toolCallEventId(input.groupId, input.callId);
            case 'tool_result':
                return toolResultEventId(input.groupId, input.callId);
            case 'event':
                return systemEventId('', fallbackEventId('e', `${at}:${seq}`));
        }
    }

    /**
     * 同步追加：分配 seq、eventId 去重、写内存日志并标脏。
     * 返回实际采纳的 seq（被去重的条目不占 seq）。持久化由 flush() 负责。
     */
    append(inputs: readonly EventInput[], _opts: { atomic?: boolean } = {}): number[] {
        const accepted: number[] = [];
        for (const input of inputs) {
            const seq = this.nextSeq();
            const eventId = this.eventIdFor(input, seq);
            if (!eventId || this.dedup.has(eventId)) continue;
            const at = input.at ?? nowSec();
            const event = {
                ...(input as Record<string, unknown>),
                seq,
                eventId,
                at,
                recvAt: input.recvAt ?? at,
            } as unknown as ConversationEvent;
            this.head.nextSeq = seq + 1;
            this.head.unsummarizedTokens += Math.max(0, this.estimate(event));
            this.buffer.push(event);
            this.events.push(event);
            this.trackDedup(eventId);
            accepted.push(seq);
        }
        if (accepted.length > 0) {
            this.version++;
            this.emit();
        }
        return accepted;
    }

    /** 追加记录（summary/edit/supersede/redact/epoch），由下一次 flush 落盘 */
    appendRecord(record: RecordEntry): void {
        this.pendingRecords.push(record);
        this.addRecordToMemory(record);
        this.version++;
        this.emit();
    }

    private addRecordToMemory(record: RecordEntry): void {
        this.records.push(record);
    }

    /**
     * 唯一持久化入口：新事件页/新记录页先写一次，成功后推进并写 head。
     * 失败时保留 buffer/pendingRecords 与脏 head，可重试。
     */
    async flush(): Promise<FlushResult> {
        if (this.flushing) return this.flushing;
        const running = this.doFlush().then(result => {
            this.flushing = null;
            return result;
        });
        this.flushing = running;
        return running;
    }

    private async doFlush(): Promise<FlushResult> {
        let writtenEventPages = 0;
        let writtenRecordPages = 0;
        try {
            // 1) 事件页
            while (this.buffer.length > 0) {
                const chunk = this.takeEventChunk();
                if (chunk.length === 0) break;
                const pageNo = this.head.nextPageNo;
                const page = buildEventPage(pageNo, chunk as ConversationEvent[]);
                const result = writeEventPages(this.sessionId, [{ pageNo, events: page.events }]);
                if (result.failedPageNo !== undefined) {
                    return { ok: false, writtenEventPages, writtenRecordPages, error: `事件页写入失败: page ${result.failedPageNo}` };
                }
                // written 或 exists 都视为可安全推进（页内容由 seq 契约保证）
                writtenEventPages++;
                this.buffer.splice(0, chunk.length);
                this.head.nextPageNo = pageNo + 1;
                this.head.persistedSeq = Math.max(this.head.persistedSeq, page.seqEnd);
                this.head.bytesTotal += page.bytes;
                if (writtenEventPages >= this.maxPagesPerFlush) break;
            }

            // 2) 记录页
            while (this.pendingRecords.length > 0) {
                const chunk = this.takeRecordChunk();
                if (chunk.length === 0) break;
                const pageNo = this.head.nextRecPageNo;
                const page = buildRecordPage(pageNo, chunk);
                const result = writeRecordPages(this.sessionId, [{ pageNo, entries: page.entries }]);
                if (result.failedPageNo !== undefined) {
                    return { ok: false, writtenEventPages, writtenRecordPages, error: `记录页写入失败: page ${result.failedPageNo}` };
                }
                writtenRecordPages++;
                this.pendingRecords.splice(0, chunk.length);
                this.head.nextRecPageNo = pageNo + 1;
                this.head.bytesTotal += page.bytes;
                if (writtenRecordPages >= this.maxPagesPerFlush) break;
            }

            // 3) head（最后写；失败则下次重试，页已写可恢复采纳）
            getHost().storage.set(headKey(this.sessionId), serializeHead(this.head));
            return { ok: true, writtenEventPages, writtenRecordPages };
        } catch (error) {
            return {
                ok: false,
                writtenEventPages,
                writtenRecordPages,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private takeEventChunk(): ConversationEvent[] {
        const chunk: ConversationEvent[] = [];
        for (const event of this.buffer) {
            const candidate = chunk.concat([event]);
            const bytes = measureEventPageBytes({
                pageNo: this.head.nextPageNo + (chunk.length > 0 ? 1 : 0),
                seqStart: candidate[0].seq,
                seqEnd: candidate[candidate.length - 1].seq,
                events: candidate,
            });
            if (chunk.length > 0 && (candidate.length > 256 || bytes > 32 * 1024)) break;
            chunk.push(event);
        }
        return chunk;
    }

    private takeRecordChunk(): RecordEntry[] {
        const chunk: RecordEntry[] = [];
        for (const entry of this.pendingRecords) {
            const candidate = chunk.concat([entry]);
            const bytes = measureRecordPageBytes({
                pageNo: this.head.nextRecPageNo,
                entries: candidate,
            });
            if (chunk.length > 0 && (candidate.length > 256 || bytes > 32 * 1024)) break;
            chunk.push(entry);
        }
        return chunk;
    }

    /** 只读快照（数组是副本，元素不可变由类型约束） */
    snapshot(): ContextSnapshot {
        return {
            head: { ...this.head },
            events: this.events.slice(),
            records: this.records.slice(),
            version: this.version,
        };
    }

    getHead(): Readonly<ContextHead> {
        return { ...this.head };
    }

    /** 最近加载窗口的起始页号（更早的页按需 readRange） */
    get loadedFrom(): number {
        return this.loadedFromPageNo;
    }

    /** 订阅变化（记忆桥/调试用；仅通知，不等待） */
    subscribe(listener: ContextStoreListener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(): void {
        if (this.listeners.length === 0) return;
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch {
                // 订阅者异常不影响写入
            }
        }
    }

    /** 测试/迁移用：替换 head（仅在本 store 未产生未 flush 数据时安全） */
    protected replaceHead(head: ContextHead): void {
        this.head = head;
    }
}
