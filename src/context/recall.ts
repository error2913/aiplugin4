// Context v2 召回层：统一地址解析 + read_raw 分页 + grep_raw 扫描 + 旧分片兼容。
//
// 契约（.dev/context-v2-design.md §8、context-v2-implementation-plan.md §4.5）：
// - 地址：`e:<seq>`、`e:<from>-<to>`、`msg_id`、`blk:`、`arc:<seq>`、`raw:<seq>`。
// - readRaw：最近事件从 snapshot 取；更早的按 page_store 页读取（先二分定位，坏页/缺页跳过并记录）。
//   分页游标 `{seq, offset}` 语义：从 seq 的第 offset 个字符继续；offset >= 文本长度表示该事件已读完。
//   **不静默截断**：游标 + exhausted + note 说明。
// - grepRaw：从新到旧扫描（未落盘尾部 → 事件页），单次最多 maxPages 页；cursor 记录下一页号（可续）。
//   跳过 epoch 外 / redact / supersede（复用 view/records 索引）；**不跳过被摘要覆盖的原文**；先 applyEdit 再搜索。
// - legacy：`arc:/raw:` 读旧分片（`getHost().storage` + legacyShardKey）；缺失/损坏返回 null。
//   `blk:` 旧原文块目录兼容待后续接线（先返回 null + note）。
// - 不依赖 seal；本模块只读 store/snapshot。
import { getHost } from "../core/host";

import { renderText } from "./content/render";
import type { ConversationEvent, EventPage } from "./events";
import { legacyShardKey } from "./keys";
import { PageStoreError, readEventPage } from "./log/page_store";
import type { ContextSnapshot, ContextStore } from "./store";
import { applyEdit, buildRecordIndex, isRedacted, isVisible, type RecordIndex } from "./view/records";

/** readRaw 默认单次返回文本预算（字符） */
export const READ_RAW_DEFAULT_MAX_CHARS = 6000;
/** readRaw 默认单次最多事件条数 */
export const READ_RAW_DEFAULT_MAX_ITEMS = 20;
/** grepRaw 默认单次最多扫描页数 */
export const GREP_DEFAULT_MAX_PAGES = 32;
/** grepRaw 默认单次最多命中条数 */
export const GREP_DEFAULT_MAX_HITS = 20;
/** grepRaw 命中片段上下文半径（字符） */
export const GREP_DEFAULT_SNIPPET_RADIUS = 60;
/** msg_id 回退扫描旧页的单次上限（防御性） */
const MSG_LOOKUP_MAX_PAGES = 256;
/** 页定位回退线性扫描上限（防御性） */
const LOCATE_MAX_PAGES = 512;

export type RecallErrorCode = 'INVALID_ARGUMENT' | 'INVALID_ADDRESS';

export class RecallError extends Error {
    readonly code: RecallErrorCode;

    constructor(code: RecallErrorCode, message: string) {
        super(message);
        this.name = 'RecallError';
        this.code = code;
    }
}

// ---------------- 地址解析 ----------------

export type ParsedAddress =
    | { kind: 'event'; fromSeq: number; toSeq: number }
    | { kind: 'legacy-shard'; shardKind: 'arc' | 'raw'; seq: number }
    | { kind: 'msg'; msgId: string }
    | { kind: 'block'; id: string }
    | { kind: 'unknown'; raw: string };

/**
 * 解析召回地址（纯函数，不访问存储）：
 * - `e:<seq>` / `e:<from>-<to>`（from>to 自动交换）
 * - `arc:<seq>` / `raw:<seq>`（旧分片序号；允许不补零）
 * - `blk:<id>`（旧原文块）
 * - 其余非空字符串按 `msg_id`（旧地址原样）。
 */
export function parseAddress(input: string): ParsedAddress {
    const text = typeof input === 'string' ? input.trim() : '';
    if (text === '') return { kind: 'unknown', raw: '' };
    const shard = /^(arc|raw):(\d{1,9})$/.exec(text);
    if (shard) {
        return { kind: 'legacy-shard', shardKind: shard[1] as 'arc' | 'raw', seq: Number(shard[2]) };
    }
    const range = /^e:(\d{1,12})-(\d{1,12})$/.exec(text);
    if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        return { kind: 'event', fromSeq: Math.min(a, b), toSeq: Math.max(a, b) };
    }
    const single = /^e:(\d{1,12})$/.exec(text);
    if (single) {
        const seq = Number(single[1]);
        return { kind: 'event', fromSeq: seq, toSeq: seq };
    }
    if (text.indexOf('blk:') === 0) return { kind: 'block', id: text.slice(4) };
    return { kind: 'msg', msgId: text };
}

// ---------------- 类型 ----------------

/** 续读游标：从 `seq` 的第 `offset` 个字符继续（offset >= 文本长度表示该事件已读完，跳过） */
export interface ReadCursor {
    readonly seq: number;
    readonly offset: number;
}

export interface RawEventItem {
    readonly type: 'event';
    readonly seq: number;
    readonly eventId: string;
    readonly kind: ConversationEvent['kind'];
    readonly text: string;
    /** 非 0 表示本条是上一页的续读片段 */
    readonly offset?: number;
}

export interface LegacyShardItem {
    readonly messageId: string;
    readonly userId: string;
    readonly time: number;
    readonly text: string;
}

export interface RawLegacyItem extends LegacyShardItem {
    readonly type: 'legacy';
    /** 分片内序（1 基），用于游标续读 */
    readonly index: number;
    readonly offset?: number;
}

export type RawItem = RawEventItem | RawLegacyItem;

export type RawReadKind = 'events' | 'legacy-shard' | 'block' | 'unknown';

export interface ReadRawOptions {
    maxChars?: number;
    maxItems?: number;
    cursor?: ReadCursor | null;
}

export interface ReadRawResult {
    readonly address: string;
    readonly kind: RawReadKind;
    readonly items: RawItem[];
    readonly cursor: ReadCursor | null;
    /** 区间内可见事件总数：仅在"全新读取且已穷尽、无缺页"时给出 */
    readonly total?: number;
    readonly exhausted: boolean;
    readonly returnedChars: number;
    readonly skippedPages: number[];
    readonly note?: string;
}

export interface GrepCursor {
    /** 下次继续扫描的页号 */
    readonly pageNo: number;
    /** 页内继续点：只扫描 seq 小于它的页内事件（缺省=整页） */
    readonly beforeSeq?: number;
}

export interface GrepOptions {
    maxPages?: number;
    maxHits?: number;
    cursor?: GrepCursor | null;
    fromSeq?: number;
    toSeq?: number;
    regex?: boolean;
    snippetRadius?: number;
}

export interface GrepHit {
    readonly seq: number;
    readonly eventId: string;
    readonly kind: ConversationEvent['kind'];
    readonly snippet: string;
    readonly text: string;
    /** 可直接用于 read_raw 的地址 */
    readonly pointer: string;
}

export interface GrepRawResult {
    readonly hits: GrepHit[];
    readonly nextCursor: GrepCursor | null;
    readonly exhausted: boolean;
    readonly scannedPages: number;
    readonly skippedPages: number[];
    readonly note?: string;
}

// ---------------- 基础工具 ----------------

function isInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

function positiveInt(value: unknown, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!isInt(value) || value < 1) throw new RecallError('INVALID_ARGUMENT', `${name} 应为 ≥1 的整数`);
    return value;
}

function normalizeCursor(cursor: ReadCursor | null | undefined): ReadCursor | null {
    if (cursor === null || cursor === undefined) return null;
    if (!isInt(cursor.seq) || cursor.seq < 1 || !isInt(cursor.offset) || cursor.offset < 0) {
        throw new RecallError('INVALID_ARGUMENT', 'cursor 非法（需要 { seq: ≥1 整数, offset: ≥0 整数 }）');
    }
    return { seq: cursor.seq, offset: cursor.offset };
}

function normalizeGrepCursor(cursor: GrepCursor | null | undefined): GrepCursor | null {
    if (cursor === null || cursor === undefined) return null;
    if (!isInt(cursor.pageNo) || cursor.pageNo < 1) throw new RecallError('INVALID_ARGUMENT', 'grep cursor.pageNo 非法');
    if (cursor.beforeSeq !== undefined && (!isInt(cursor.beforeSeq) || cursor.beforeSeq < 1)) {
        throw new RecallError('INVALID_ARGUMENT', 'grep cursor.beforeSeq 非法');
    }
    return cursor.beforeSeq === undefined ? { pageNo: cursor.pageNo } : { pageNo: cursor.pageNo, beforeSeq: cursor.beforeSeq };
}

function uniqueSorted(values: number[]): number[] {
    return Array.from(new Set(values)).sort((a, b) => a - b);
}

function pageSummary(pages: number[]): string {
    const unique = uniqueSorted(pages);
    const shown = unique.slice(0, 5).join(',');
    return `缺页/坏页 ${unique.length} 个（${shown}${unique.length > 5 ? '…' : ''}）`;
}

// ---------------- 展示文本 ----------------

/**
 * 事件用于召回/搜索的规范文本（applyEdit 后）：
 * 带来源前缀，保证 read_raw 单条输出自描述；tool_call 无 parts 时回退原始 args。
 */
export function eventRecallText(event: ConversationEvent, index?: RecordIndex): string {
    const parts = index ? applyEdit(event, index) : ((event as { parts?: unknown }).parts);
    const body = renderText(Array.isArray(parts) ? parts : []);
    switch (event.kind) {
        case 'user': {
            const from = event.uid ? `[from:${event.uid}]` : '';
            const msg = event.msgId ? `[msg_id:${event.msgId}]` : '';
            return `${from}${msg} ${body}`.trim();
        }
        case 'assistant':
            return `${event.msgId ? `[msg_id:${event.msgId}] ` : ''}${body}`.trim();
        case 'tool_call':
            return `[tool_call:${event.name}${event.callId ? `#${event.callId}` : ''}] ${body || event.args || ''}`.trim();
        case 'tool_result':
            return `[tool_result${event.name ? `:${event.name}` : ''}${event.callId ? `#${event.callId}` : ''}] ${body}`.trim();
        case 'event':
            return `[event:${event.systemName}] ${body}`.trim();
        default:
            return body;
    }
}

// ---------------- 页读取（坏页/缺页跳过，读失败上抛） ----------------

type PageReadOutcome =
    | { status: 'ok'; page: EventPage }
    | { status: 'skip' }
    | { status: 'error'; error: unknown };

function readPageForRecall(sessionId: string, pageNo: number): PageReadOutcome {
    try {
        const page = readEventPage(sessionId, pageNo);
        return page ? { status: 'ok', page } : { status: 'skip' };
    } catch (error) {
        if (error instanceof PageStoreError && error.code === 'INVALID_PAGE') return { status: 'skip' };
        return { status: 'error', error };
    }
}

function locateStartPage(
    sessionId: string,
    pageFloor: number,
    lastPageNo: number,
    targetSeq: number,
    skipped: number[],
): { pageNo: number } | null {
    let lo = pageFloor;
    let hi = lastPageNo;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const outcome = readPageForRecall(sessionId, mid);
        if (outcome.status === 'error') throw outcome.error;
        if (outcome.status === 'skip') return locateStartPageLinear(sessionId, pageFloor, lastPageNo, targetSeq, skipped);
        if (outcome.page.seqEnd < targetSeq) {
            lo = mid + 1;
            continue;
        }
        if (outcome.page.seqStart > targetSeq) {
            hi = mid - 1;
            continue;
        }
        return { pageNo: mid };
    }
    // seq 落在页间空洞（旧 epoch/清理）时，找第一个覆盖它的页
    if (lo <= lastPageNo) {
        const outcome = readPageForRecall(sessionId, lo);
        if (outcome.status === 'error') throw outcome.error;
        if (outcome.status === 'ok' && outcome.page.seqEnd >= targetSeq) return { pageNo: lo };
        if (outcome.status === 'skip') skipped.push(lo);
    }
    return locateStartPageLinear(sessionId, pageFloor, lastPageNo, targetSeq, skipped);
}

function locateStartPageLinear(
    sessionId: string,
    pageFloor: number,
    lastPageNo: number,
    targetSeq: number,
    skipped: number[],
): { pageNo: number } | null {
    const cap = Math.min(lastPageNo - pageFloor + 1, LOCATE_MAX_PAGES);
    for (let scanned = 0, pageNo = pageFloor; pageNo <= lastPageNo && scanned < cap; pageNo++, scanned++) {
        const outcome = readPageForRecall(sessionId, pageNo);
        if (outcome.status === 'error') throw outcome.error;
        if (outcome.status === 'skip') {
            skipped.push(pageNo);
            continue;
        }
        if (outcome.page.seqEnd >= targetSeq) return { pageNo };
    }
    return null;
}

// ---------------- readRaw ----------------

interface ReadAccumulator {
    items: RawEventItem[];
    usedChars: number;
    cursor: ReadCursor | null;
    hidden: number;
    candidates: number;
    skippedPages: number[];
    locateFailed: boolean;
}

function createAccumulator(): ReadAccumulator {
    return { items: [], usedChars: 0, cursor: null, hidden: 0, candidates: 0, skippedPages: [], locateFailed: false };
}

/** 把一个事件按预算追加到 readRaw 结果；返回 false 表示已达预算（cursor 已设置） */
function feedEvent(
    acc: ReadAccumulator,
    event: ConversationEvent,
    index: RecordIndex,
    cursor: ReadCursor | null,
    maxChars: number,
    maxItems: number,
): boolean {
    if (event.seq < index.epochStartSeq || isRedacted(event, index)) {
        acc.hidden++;
        return true;
    }
    const text = eventRecallText(event, index);
    const offset = cursor && cursor.seq === event.seq ? Math.max(0, cursor.offset) : 0;
    if (offset >= text.length) return true;   // 该事件在上一页已读完（或空事件）
    if (text.length === 0) return true;
    const rest = offset > 0 ? text.slice(offset) : text;
    const remainingChars = maxChars - acc.usedChars;
    if (acc.items.length >= maxItems || remainingChars <= 0) {
        acc.cursor = { seq: event.seq, offset };
        return false;
    }
    const take = Math.min(rest.length, remainingChars);
    const piece = take > 0 ? rest.slice(0, take) : '';
    if (piece.length > 0) {
        acc.items.push({
            type: 'event',
            seq: event.seq,
            eventId: event.eventId,
            kind: event.kind,
            text: piece,
            ...(offset > 0 ? { offset } : {}),
        });
        acc.usedChars += piece.length;
        acc.candidates++;
    }
    if (take < rest.length) {
        acc.cursor = { seq: event.seq, offset: offset + take };
        return false;
    }
    if (acc.items.length >= maxItems) {
        acc.cursor = { seq: event.seq, offset: text.length };
        return false;
    }
    return true;
}

function buildEventReadResult(
    address: string,
    acc: ReadAccumulator,
    options: { exhausted: boolean; fresh: boolean; fromSeq: number; pageFloor: number; locateFailed: boolean },
): ReadRawResult {
    const skippedPages = uniqueSorted(acc.skippedPages);
    const notes: string[] = [];
    if (acc.hidden > 0) notes.push(`${acc.hidden} 条已按记录索引隐藏（epoch/redact）`);
    if (skippedPages.length > 0) notes.push(pageSummary(skippedPages));
    if (options.locateFailed) notes.push('较早页缺失，起点无法精确定位（已从可定位处开始）');
    if (options.fromSeq < options.pageFloor) notes.push(`seq<${options.pageFloor} 的原文已被清理`);
    if (options.exhausted && acc.items.length === 0 && notes.length === 0) {
        notes.push(`区间 ${address} 内没有可读事件（seq 可能已清理、被隐藏或本会话不存在）`);
    }
    const total = options.exhausted
        && options.fresh
        && skippedPages.length === 0
        && !options.locateFailed
        && options.fromSeq >= options.pageFloor
        ? acc.candidates
        : undefined;
    return {
        address,
        kind: 'events',
        items: acc.items,
        cursor: acc.cursor,
        ...(total === undefined ? {} : { total }),
        exhausted: options.exhausted,
        returnedChars: acc.usedChars,
        skippedPages,
        ...(notes.length > 0 ? { note: notes.join('；') } : {}),
    };
}

function readRawEventRange(
    store: ContextStore,
    snapshot: ContextSnapshot,
    fromSeqRaw: number,
    toSeqRaw: number,
    options: ReadRawOptions,
): ReadRawResult {
    const maxChars = positiveInt(options.maxChars, READ_RAW_DEFAULT_MAX_CHARS, 'maxChars');
    const maxItems = positiveInt(options.maxItems, READ_RAW_DEFAULT_MAX_ITEMS, 'maxItems');
    const cursor = normalizeCursor(options.cursor);
    const address = fromSeqRaw === toSeqRaw ? `e:${fromSeqRaw}` : `e:${fromSeqRaw}-${toSeqRaw}`;
    if (!isInt(fromSeqRaw) || !isInt(toSeqRaw) || fromSeqRaw < 1 || toSeqRaw < 1) {
        throw new RecallError('INVALID_ADDRESS', `事件地址非法：${address}`);
    }
    const fromSeq = Math.max(1, Math.min(fromSeqRaw, toSeqRaw));
    const toSeq = Math.max(fromSeqRaw, toSeqRaw);
    let startSeq = fromSeq;
    if (cursor && cursor.seq > startSeq) startSeq = cursor.seq;
    const head = snapshot.head;
    const pageFloor = head.pageFloor;
    const lastPageNo = head.nextPageNo - 1;
    const acc = createAccumulator();
    const fresh = cursor === null;

    if (startSeq > toSeq) {
        return buildEventReadResult(address, acc, { exhausted: true, fresh, fromSeq, pageFloor, locateFailed: false });
    }

    const events = snapshot.events.slice().sort((a, b) => a.seq - b.seq);
    const snapMin = events.length > 0 ? events[0].seq : Number.POSITIVE_INFINITY;
    const diskTo = Math.min(toSeq, snapMin - 1);
    const index = buildRecordIndex(snapshot.records);

    // 1) 尚未进入内存窗口的较旧事件：按页读取（二分定位 → 顺序读到 diskTo）
    if (startSeq <= diskTo && lastPageNo >= pageFloor) {
        const skipped: number[] = [];
        const located = locateStartPage(store.sessionId, pageFloor, lastPageNo, startSeq, skipped);
        acc.skippedPages.push(...skipped);
        if (!located) acc.locateFailed = true;
        else {
            let pageNo = located.pageNo;
            while (pageNo <= lastPageNo) {
                const outcome = readPageForRecall(store.sessionId, pageNo);
                if (outcome.status === 'error') throw outcome.error;
                if (outcome.status === 'skip') {
                    acc.skippedPages.push(pageNo);
                    pageNo++;
                    continue;
                }
                const page = outcome.page;
                if (page.seqEnd < startSeq) {
                    pageNo++;
                    continue;
                }
                for (const event of page.events) {
                    if (event.seq < startSeq) continue;
                    if (event.seq > diskTo) break;
                    if (!feedEvent(acc, event, index, cursor, maxChars, maxItems)) {
                        return buildEventReadResult(address, acc, { exhausted: false, fresh, fromSeq, pageFloor, locateFailed: acc.locateFailed });
                    }
                }
                if (page.seqEnd >= diskTo) break;
                pageNo++;
            }
        }
    }
    if (acc.cursor) {
        return buildEventReadResult(address, acc, { exhausted: false, fresh, fromSeq, pageFloor, locateFailed: acc.locateFailed });
    }

    // 2) 内存窗口内的事件（新；含尚未 flush 的尾部）
    const snapStart = Math.max(startSeq, snapMin);
    for (const event of events) {
        if (event.seq < snapStart) continue;
        if (event.seq > toSeq) break;
        if (!feedEvent(acc, event, index, cursor, maxChars, maxItems)) {
            return buildEventReadResult(address, acc, { exhausted: false, fresh, fromSeq, pageFloor, locateFailed: acc.locateFailed });
        }
    }
    return buildEventReadResult(address, acc, { exhausted: true, fresh, fromSeq, pageFloor, locateFailed: acc.locateFailed });
}

function isMsgIdMatch(event: ConversationEvent, msgId: string): boolean {
    if (event.eventId === msgId) return true;
    if (event.kind === 'user' || event.kind === 'assistant') return event.msgId === msgId;
    return false;
}

function findEventByMsgId(
    store: ContextStore,
    snapshot: ContextSnapshot,
    msgId: string,
    skipped: number[],
): ConversationEvent | null {
    const events = snapshot.events.slice().sort((a, b) => b.seq - a.seq);
    for (const event of events) {
        if (isMsgIdMatch(event, msgId)) return event;
    }
    const head = snapshot.head;
    const pageFloor = head.pageFloor;
    let pageNo = head.nextPageNo - 1;
    for (let scanned = 0; pageNo >= pageFloor && scanned < MSG_LOOKUP_MAX_PAGES; scanned++, pageNo--) {
        const outcome = readPageForRecall(store.sessionId, pageNo);
        if (outcome.status === 'error') throw outcome.error;
        if (outcome.status === 'skip') {
            skipped.push(pageNo);
            continue;
        }
        for (let i = outcome.page.events.length - 1; i >= 0; i--) {
            if (isMsgIdMatch(outcome.page.events[i], msgId)) return outcome.page.events[i];
        }
    }
    return null;
}

function readRawMsg(
    store: ContextStore,
    snapshot: ContextSnapshot,
    msgId: string,
    options: ReadRawOptions,
): ReadRawResult {
    if (msgId === '') throw new RecallError('INVALID_ADDRESS', 'msg_id 不能为空');
    const maxChars = positiveInt(options.maxChars, READ_RAW_DEFAULT_MAX_CHARS, 'maxChars');
    const maxItems = positiveInt(options.maxItems, READ_RAW_DEFAULT_MAX_ITEMS, 'maxItems');
    const cursor = normalizeCursor(options.cursor);
    const skipped: number[] = [];
    const event = findEventByMsgId(store, snapshot, msgId, skipped);
    const acc = createAccumulator();
    acc.skippedPages.push(...skipped);
    const pageFloor = snapshot.head.pageFloor;
    if (!event) {
        return {
            address: msgId,
            kind: 'events',
            items: [],
            cursor: null,
            exhausted: true,
            returnedChars: 0,
            skippedPages: uniqueSorted(skipped),
            note: `${pageSummary(skipped)}；未找到 msg_id=${msgId}（可能已清理或不属于本会话）`,
        };
    }
    const index = buildRecordIndex(snapshot.records);
    const done = feedEvent(acc, event, index, cursor, maxChars, maxItems);
    return buildEventReadResult(msgId, acc, {
        exhausted: done,
        fresh: cursor === null,
        fromSeq: event.seq,
        pageFloor,
        locateFailed: false,
    });
}

function readLegacyAddress(
    store: ContextStore,
    parsed: Extract<ParsedAddress, { kind: 'legacy-shard' }>,
    options: ReadRawOptions,
): ReadRawResult {
    const maxChars = positiveInt(options.maxChars, READ_RAW_DEFAULT_MAX_CHARS, 'maxChars');
    const maxItems = positiveInt(options.maxItems, READ_RAW_DEFAULT_MAX_ITEMS, 'maxItems');
    const cursor = normalizeCursor(options.cursor);
    const address = `${parsed.shardKind}:${parsed.seq}`;
    const shard = readLegacyShard(store.sessionId, parsed.shardKind, parsed.seq);
    if (!shard) {
        return {
            address,
            kind: 'legacy-shard',
            items: [],
            cursor: null,
            total: 0,
            exhausted: true,
            returnedChars: 0,
            skippedPages: [],
            note: '旧分片不存在、已清理或内容损坏（arc:/raw: 只读兼容）',
        };
    }
    const items: RawLegacyItem[] = [];
    let usedChars = 0;
    let nextCursor: ReadCursor | null = null;
    const startIndex = cursor ? Math.max(0, cursor.seq - 1) : 0;
    const startOffset = cursor ? cursor.offset : 0;
    for (let i = startIndex; i < shard.length; i++) {
        const offset = i === startIndex ? startOffset : 0;
        const text = shard[i].text;
        if (offset >= text.length) continue;
        const rest = offset > 0 ? text.slice(offset) : text;
        const remainingChars = maxChars - usedChars;
        if (items.length >= maxItems || remainingChars <= 0) {
            nextCursor = { seq: i + 1, offset };
            break;
        }
        const take = Math.min(rest.length, remainingChars);
        const piece = take > 0 ? rest.slice(0, take) : '';
        if (piece.length > 0) {
            const base = shard[i];
            items.push({
                type: 'legacy',
                messageId: base.messageId,
                userId: base.userId,
                time: base.time,
                text: piece,
                index: i + 1,
                ...(offset > 0 ? { offset } : {}),
            });
            usedChars += piece.length;
        }
        if (take < rest.length) {
            nextCursor = { seq: i + 1, offset: offset + take };
            break;
        }
        if (items.length >= maxItems) {
            nextCursor = { seq: i + 1, offset: text.length };
            break;
        }
    }
    return {
        address,
        kind: 'legacy-shard',
        items,
        cursor: nextCursor,
        total: shard.length,
        exhausted: nextCursor === null,
        returnedChars: usedChars,
        skippedPages: [],
        ...(shard.length === 0 ? { note: '旧分片存在但没有可读条目' } : {}),
    };
}

/**
 * 读旧版 arc/raw 分片（只读兼容）。
 * 海豹 storageGet 对缺失 key 抛异常、损坏 JSON 也不可用：两者一律返回 null（旧数据，不阻塞新链路）。
 */
export function readLegacyShard(sessionId: string, shardKind: 'arc' | 'raw', seq: number): LegacyShardItem[] | null {
    if (!sessionId || !isInt(seq) || seq < 1) return null;
    let raw: string | null;
    try {
        raw = getHost().storage.get(legacyShardKey(sessionId, shardKind, seq));
    } catch {
        return null;
    }
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    const out: LegacyShardItem[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.text !== 'string') continue;
        out.push({
            messageId: typeof record.messageId === 'string' ? record.messageId : '',
            userId: typeof record.userId === 'string' ? record.userId : '',
            time: typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : 0,
            text: record.text,
        });
    }
    return out;
}

/**
 * 统一召回读取（read_raw）。
 * @param store 提供 sessionId（页存储按会话寻址）
 * @param snapshot 当前只读快照（最近窗口 + head）
 */
export function readRaw(
    store: ContextStore,
    snapshot: ContextSnapshot,
    address: string,
    options: ReadRawOptions = {},
): ReadRawResult {
    const parsed = parseAddress(address);
    switch (parsed.kind) {
        case 'event':
            return readRawEventRange(store, snapshot, parsed.fromSeq, parsed.toSeq, options);
        case 'legacy-shard':
            return readLegacyAddress(store, parsed, options);
        case 'msg':
            return readRawMsg(store, snapshot, parsed.msgId, options);
        case 'block':
            return {
                address: parsed.id,
                kind: 'block',
                items: [],
                cursor: null,
                total: 0,
                exhausted: true,
                returnedChars: 0,
                skippedPages: [],
                note: `旧原文块 blk:${parsed.id} 的兼容读取尚未接线；迁移期请用 arc:/raw:/e:/msg_id 地址`,
            };
        default:
            return {
                address: parsed.raw,
                kind: 'unknown',
                items: [],
                cursor: null,
                exhausted: true,
                returnedChars: 0,
                skippedPages: [],
                note: `无法识别的召回地址：${parsed.raw}（支持 e:<seq>、e:<from>-<to>、msg_id、blk:、arc:<seq>、raw:<seq>）`,
            };
    }
}

// ---------------- grepRaw ----------------

type Matcher = (text: string) => { index: number; length: number } | null;

function buildMatcher(pattern: string, regex: boolean): Matcher {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new RecallError('INVALID_ARGUMENT', 'pattern 不能为空');
    }
    if (regex) {
        let compiled: RegExp;
        try {
            compiled = new RegExp(pattern, 'i');
        } catch (error) {
            throw new RecallError('INVALID_ARGUMENT', `正则非法：${error instanceof Error ? error.message : String(error)}`);
        }
        return (text: string) => {
            const match = compiled.exec(text);
            return match ? { index: match.index, length: match[0].length } : null;
        };
    }
    const needle = pattern.toLowerCase();
    return (text: string) => {
        const index = text.toLowerCase().indexOf(needle);
        return index < 0 ? null : { index, length: pattern.length };
    };
}

function makeSnippet(text: string, index: number, patternLength: number, radius: number): string {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + patternLength + radius);
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

function buildGrepResult(
    hits: GrepHit[],
    nextCursor: GrepCursor | null,
    exhausted: boolean,
    scannedPages: number,
    skippedPages: number[],
    hidden: number,
): GrepRawResult {
    const notes: string[] = [];
    if (hidden > 0) notes.push(`已跳过 ${hidden} 条不可见事件（epoch/redact/supersede）`);
    const skipped = uniqueSorted(skippedPages);
    if (skipped.length > 0) notes.push(pageSummary(skipped));
    return {
        hits,
        nextCursor,
        exhausted,
        scannedPages,
        skippedPages: skipped,
        ...(notes.length > 0 ? { note: notes.join('；') } : {}),
    };
}

/**
 * 关键词/正则检索（grep_raw）：从新到旧扫描「未落盘尾部 → 事件页」，单次最多 maxPages 页。
 * 跳过 epoch 外 / redact / supersede 事件；摘要覆盖的原文照常可搜；搜索前应用 EditRecord。
 */
export function grepRaw(
    store: ContextStore,
    snapshot: ContextSnapshot,
    pattern: string,
    options: GrepOptions = {},
): GrepRawResult {
    const maxPages = positiveInt(options.maxPages, GREP_DEFAULT_MAX_PAGES, 'maxPages');
    const maxHits = positiveInt(options.maxHits, GREP_DEFAULT_MAX_HITS, 'maxHits');
    const radius = positiveInt(options.snippetRadius, GREP_DEFAULT_SNIPPET_RADIUS, 'snippetRadius');
    const matcher = buildMatcher(pattern, options.regex === true);
    const cursor = normalizeGrepCursor(options.cursor);
    const head = snapshot.head;
    const pageFloor = head.pageFloor;
    const fromSeq = options.fromSeq === undefined ? 0 : options.fromSeq;
    const toSeq = options.toSeq === undefined ? Number.MAX_SAFE_INTEGER : options.toSeq;
    if (!isInt(fromSeq) || fromSeq < 0) throw new RecallError('INVALID_ARGUMENT', 'fromSeq 应为 ≥0 的整数');
    if (!isInt(toSeq) || toSeq < 1) throw new RecallError('INVALID_ARGUMENT', 'toSeq 应为 ≥1 的整数');

    const index = buildRecordIndex(snapshot.records);
    const events = snapshot.events.slice().sort((a, b) => a.seq - b.seq);
    const persistedSeq = head.persistedSeq;
    const hits: GrepHit[] = [];
    const skippedPages: number[] = [];
    let scannedPages = 0;
    let hidden = 0;
    let stopAll = false;

    const scanEvent = (event: ConversationEvent): boolean => {
        if (event.seq > toSeq) return true;
        if (event.seq < fromSeq) {
            stopAll = true;
            return true;
        }
        if (!isVisible(event, index)) {
            hidden++;
            return true;
        }
        const text = eventRecallText(event, index);
        const match = matcher(text);
        if (!match) return true;
        hits.push({
            seq: event.seq,
            eventId: event.eventId,
            kind: event.kind,
            snippet: makeSnippet(text, match.index, match.length, radius),
            text,
            pointer: `read_raw id=e:${event.seq}`,
        });
        return hits.length < maxHits;
    };

    // 1) 未落盘尾部（无 cursor，或 cursor 指向尾部哨兵）：仅在当前内存快照里
    if (!cursor || cursor.pageNo >= head.nextPageNo) {
        const before = cursor && cursor.beforeSeq !== undefined ? cursor.beforeSeq : Number.MAX_SAFE_INTEGER;
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.seq <= persistedSeq) continue;
            if (event.seq >= before) continue;
            if (!scanEvent(event)) {
                return buildGrepResult(hits, { pageNo: head.nextPageNo, beforeSeq: event.seq }, false, scannedPages, skippedPages, hidden);
            }
            if (stopAll) {
                return buildGrepResult(hits, null, true, scannedPages, skippedPages, hidden);
            }
        }
    }

    // 2) 事件页从新到旧扫描
    let pageNo = cursor
        ? Math.min(cursor.pageNo, head.nextPageNo - 1)
        : head.nextPageNo - 1;
    let beforeSeq = cursor ? cursor.beforeSeq : undefined;

    while (pageNo >= pageFloor && !stopAll) {
        if (scannedPages >= maxPages) {
            return buildGrepResult(hits, { pageNo, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, false, scannedPages, skippedPages, hidden);
        }
        const outcome = readPageForRecall(store.sessionId, pageNo);
        scannedPages++;
        if (outcome.status === 'error') throw outcome.error;
        if (outcome.status === 'skip') {
            skippedPages.push(pageNo);
            pageNo--;
            beforeSeq = undefined;
            continue;
        }
        const pageEvents = outcome.page.events;
        for (let i = pageEvents.length - 1; i >= 0; i--) {
            const event = pageEvents[i];
            if (beforeSeq !== undefined && event.seq >= beforeSeq) continue;
            if (!scanEvent(event)) {
                return buildGrepResult(hits, { pageNo, beforeSeq: event.seq }, false, scannedPages, skippedPages, hidden);
            }
            if (stopAll) break;
        }
        if (stopAll) break;
        pageNo--;
        beforeSeq = undefined;
    }

    const exhausted = stopAll || pageNo < pageFloor;
    return buildGrepResult(hits, null, exhausted, scannedPages, skippedPages, hidden);
}
