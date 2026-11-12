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
import { isInjection } from "./injections";
import { eventPageKey, headKey } from "./keys";
import {
    buildEventPage,
    EVENT_PAGE_MAX_BYTES,
    EVENT_PAGE_MAX_EVENTS,
    EVENT_PAGE_MAX_SINGLE_EVENT_BYTES,
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
    /**
     * 归档后是否保留原文页（默认 true）。
     * false = 「归档保留原文=关」：已摘要覆盖（seqEnd <= summarizedThrough）的事件页物理清除，
     * pageFloor/deletedThrough 前移，之后检索不可达。
     */
    keepArchivedRaw?: boolean;
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
    private readonly keepArchivedRaw: boolean;
    private loadedFromPageNo = 1;

    private constructor(sessionId: string, head: ContextHead, opts: ContextStoreOptions = {}) {
        this.sessionId = sessionId;
        this.head = head;
        this.estimate = opts.estimateEventTokens ?? ((event: ConversationEvent) => Math.max(1, Math.ceil(JSON.stringify(event).length / 4)));
        this.loadRecentPages = Math.max(1, Math.floor(opts.loadRecentPages ?? DEFAULT_LOAD_RECENT_PAGES));
        this.loadRecordPagesLimit = Math.max(1, Math.floor(opts.loadRecordPages ?? 256));
        this.maxPagesPerFlush = Math.max(1, Math.floor(opts.maxPagesPerFlush ?? DEFAULT_MAX_PAGES_PER_FLUSH));
        this.keepArchivedRaw = opts.keepArchivedRaw !== false;
    }

    /**
     * 打开会话：读 head → 采纳 head 之后已写页（崩溃恢复）→ 加载最近事件页与全部记录页。
     * 没有任何 v2 数据时返回空 store（迁移由上层负责，不能在这里自动迁移）。
     */
    static openSync(sessionId: string, opts: ContextStoreOptions = {}): ContextStore {
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

    static async open(sessionId: string, opts: ContextStoreOptions = {}): Promise<ContextStore> {
        return ContextStore.openSync(sessionId, opts);
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

    /**
     * 事件 id 是否已在本会话出现过（REQ-D6-06 去重判定）。
     * 只读既有去重集合（含已加载页；不新建持久化结构）。
     * 注意：归档页被清理或去重上限（MAX_DEDUP_IDS）淘汰后可能丢失 ⇒ 引用展开"只写一次"是 best-effort。
     */
    hasEvent(eventId: string): boolean {
        return !!eventId && this.dedup.has(eventId);
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
            const tokens = Math.max(0, this.estimate(event));
            // #163 D3-13 第 1/4 处：注入块只进 activeInjectTokens（每轮现算，不落 head），
            // 否则 T = unarchived + summary + activeInject 会把同一批 token 算两次 ⇒ 提前归档
            if (!isInjection(event)) {
                this.head.unsummarizedTokens += tokens;
                this.head.unarchivedTokens += tokens;
            }
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

    /**
     * 提交一次压缩结果：追加 summary 记录并推进 summarizedThrough（由 compactor 调用）。
     * 只改内存与脏标记；持久化由下一次 flush 完成。
     */
    commitSummary(record: RecordEntry, summarizedThrough: number, unsummarizedTokens: number): void {
        this.appendRecord(record);
        this.head.summarizedThrough = Math.max(this.head.summarizedThrough, Math.floor(summarizedThrough));
        this.head.unsummarizedTokens = Math.max(0, Math.floor(unsummarizedTokens));
        // 摘要覆盖即对模型不可见：归档边界随摘要前进（保持 archivedThrough >= summarizedThrough）。
        // 这样 T 的原文部分会随摘要同步下降，不会把已摘要内容继续计入触发水位。
        if (this.head.summarizedThrough > this.head.archivedThrough) {
            this.head.archivedThrough = this.head.summarizedThrough;
            let unarchived = 0;
            for (const event of this.events) {
                // #163 D3-13 第 2/4 处：重算同样跳过注入块（口径必须与 append 一致）
                if (event.seq > this.head.archivedThrough && !isInjection(event)) {
                    unarchived += Math.max(0, this.estimate(event));
                }
            }
            this.head.unarchivedTokens = unarchived;
        }
        // 「归档保留原文=关」：只清理已被摘要覆盖的页（未总结的硬切/待机归档必须保留原文，
        // 否则后续总结无法覆盖、检索也丢失）。
        if (!this.keepArchivedRaw) this.deleteArchivedPages();
        this.version++;
        this.emit();
    }

    /**
     * 物理清除已被摘要覆盖的事件页（seqEnd <= summarizedThrough），并按页前缀前移 pageFloor。
     * 只处理已落盘页（未 flush 的尾部缓冲区不动）；失败时停止（下次 flush 后重试）。
     */
    private deleteArchivedPages(): void {
        const limit = this.head.summarizedThrough;
        if (limit <= 0) return;
        let pageNo = this.head.pageFloor;
        let deletedThrough = this.head.deletedThrough;
        while (pageNo < this.head.nextPageNo) {
            let page;
            try {
                page = readEventPage(this.sessionId, pageNo);
            } catch {
                break;
            }
            if (!page) {
                // 页已不存在（重复清理/损坏）：按已清理处理，继续前移
                this.head.pageFloor = pageNo + 1;
                pageNo += 1;
                continue;
            }
            if (page.seqEnd > limit) break;
            try {
                getHost().storage.set(eventPageKey(this.sessionId, pageNo), '');
            } catch {
                break;
            }
            deletedThrough = Math.max(deletedThrough, page.seqEnd);
            this.head.pageFloor = pageNo + 1;
            pageNo += 1;
        }
        this.head.deletedThrough = Math.max(this.head.deletedThrough, Math.min(limit, deletedThrough));
    }

    /**
     * 提交一次归档（硬切 / 待机归档 / 总结完成）：推进 archivedThrough 并重算未归档 token。
     *
     * - 只进不退、幂等：目标 <= 当前 archivedThrough 时是空操作；
     * - 「未归档 token」按内存窗口中 seq > archivedThrough 的事件重算（归档起点来自已加载单元，
     *   因此更早的未加载事件都落在边界之前）；
     * - 只改内存与脏标记，持久化由下一次 flush 完成。
     *
     * @returns 实际生效的 archivedThrough
     */
    commitArchive(toSeq: number): number {
        const raw = Number.isFinite(toSeq) ? Math.floor(toSeq) : 0;
        const target = Math.max(this.head.archivedThrough, Math.min(this.head.nextSeq - 1, raw));
        if (target <= this.head.archivedThrough) return this.head.archivedThrough;
        this.head.archivedThrough = target;
        let unarchived = 0;
        for (const event of this.events) {
            // #163 D3-13 第 3/4 处：归档重算同样跳过注入块
            if (event.seq > target && !isInjection(event)) {
                unarchived += Math.max(0, this.estimate(event));
            }
        }
        this.head.unarchivedTokens = unarchived;
        this.version++;
        this.emit();
        return target;
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
            if (chunk.length === 0) {
                // 首条事件独占一页：放宽到单事件页上限（大工具结果不再让 flush 永久失败）。
                // 超过该上限的事件已在入库前截断（见 context.appendToolResult）；这里仍单独成页，
                // 避免与后续事件拼成一个注定被 buildEventPage 拒绝的页。
                chunk.push(event);
                if (bytes > EVENT_PAGE_MAX_SINGLE_EVENT_BYTES) break;
                continue;
            }
            // 多事件页仍按 32KB / 256 条切（与 page_store 校验口径一致）
            if (candidate.length > EVENT_PAGE_MAX_EVENTS || bytes > EVENT_PAGE_MAX_BYTES) break;
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
