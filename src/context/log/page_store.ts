// Context v2 事件页存储（evt:<sid>:<pageNo>）：只写一次、页自描述、崩溃恢复探测。
//
// 契约（.dev/context-v2-design.md §4、context-v2-implementation-plan.md §3.1/§4.1）：
// - 存储只走 `getHost().storage`（不直接 import seal）；事件本体不进 head。
// - 海豹 `storageGet` 对不存在的 key **会抛异常**：本模块把"缺失"归一为 `null`，
//   把"读失败/页损坏"抛 `PageStoreError`，由上层决定重试/隔离/修复（不静默吞）。
// - 页号从 1 连续递增、不复用；页内 seq 连续；页内容自描述（pageNo/seqStart/seqEnd/bytes/events）。
// - 单页 256 条 / 32KB 上限由**调用方切片**，store 只校验（超限视为调用方参数错误）。
// - 写入幂等：已存在的页不再写（只写一次）；已存在但 seq 范围不同的页拒绝覆盖（数据异常，交上层）。
//
// `bytes` 口径：事件负载（pageNo/seqStart/seqEnd/events）的 JSON 序列化长度，**不含 bytes 字段本身**。
// 这样定义是确定可复算的（避免"bytes 包含自身长度"的循环依赖），读取时用它做自描述一致性校验。
import { getHost } from '../../core/host';
import type { ConversationEvent, EventPage } from '../events';
import { eventPageKey } from '../keys';

/** 单页事件条数上限（调用方切片，store 只校验） */
export const EVENT_PAGE_MAX_EVENTS = 256;
/** 单页负载字节上限（调用方切片，store 只校验） */
export const EVENT_PAGE_MAX_BYTES = 32 * 1024;
/** 恢复探测单次最多采纳的页数：防止异常数据导致同步长循环，未采纳完可再次调用 */
export const EVENT_RECOVERY_MAX_PAGES = 256;

/** PageStoreError 分类：READ_FAILED=存储读失败（非缺失）；INVALID_PAGE=页内容损坏；INVALID_ARGUMENT=调用方传参非法 */
export type PageStoreErrorCode = 'READ_FAILED' | 'INVALID_PAGE' | 'INVALID_ARGUMENT';

export class PageStoreError extends Error {
    readonly code: PageStoreErrorCode;
    readonly pageNo: number | undefined;

    constructor(code: PageStoreErrorCode, message: string, pageNo?: number) {
        super(message);
        this.name = 'PageStoreError';
        this.code = code;
        this.pageNo = pageNo;
    }
}

/** 事件页写入结果：written=新写；exists=页已存在（内容已在盘上，可安全推进 head）；failed=写失败（调用方保留待写数据） */
export type WritePageResult = 'written' | 'exists' | 'failed';

/** 写入一批页的结果：遇 failed 立即停止（后续页由调用方保留重试） */
export interface EventPageBatchWriteResult {
    written: number;
    exists: number;
    /** 第一张写失败的页号（undefined=全部成功） */
    failedPageNo?: number;
}

/** `probeStoredString` 结果：ok=读到内容；missing=key 不存在（含被置空）；error=存储读失败 */
export type StoredStringProbe =
    | { status: 'ok'; raw: string }
    | { status: 'missing' }
    | { status: 'error'; error: unknown };

export function describeStorageError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
}

/**
 * 识别"key 不存在"异常。
 * 海豹 storageGet 的契约是"不存在**或**失败时抛异常"，两者只能靠错误形状区分：
 * 这里识别常见 not-found 文案/错误码；不匹配的异常一律按读失败处理（宁可报错也不静默当缺失）。
 * 注：真实海豹 storageGet 的异常文案未在单测中验证（P0 探针待补），见未决问题。
 */
export function isMissingKeyError(error: unknown): boolean {
    if (error && typeof error === 'object') {
        const code = (error as { code?: unknown }).code;
        if (code === 'NOT_FOUND' || code === 'ENOENT' || code === 'not_found') return true;
    }
    return /not\s*found|does not exist|no such (?:key|record|entry)|不存在|未找到|找不到/i.test(describeStorageError(error));
}

let missingKeyErrorDetector: (error: unknown) => boolean = isMissingKeyError;

/**
 * 覆盖"缺失 key 异常"判定器（生产环境在 P0 探针确认海豹 storageGet 异常形状后安装精确判定）。
 * 传 null 恢复默认启发式。只在装配期调用一次；本模块不依赖 seal，也不改 HostSeam 端口。
 */
export function setMissingKeyErrorDetector(detector: ((error: unknown) => boolean) | null): void {
    missingKeyErrorDetector = detector ?? isMissingKeyError;
}

/**
 * 探测一个存储 key（页/记录共用的底层读取）：
 * - 不存在（抛 not-found / 返回 null / 返回空串）→ missing；
 * - 读取失败 → error（**不**当作缺失，避免把暂时故障误判成"尾部未写"而丢数据）；
 * - 正常返回 → ok。
 */
export function probeStoredString(key: string): StoredStringProbe {
    try {
        const raw = getHost().storage.get(key);
        if (raw === null || raw === undefined || raw === '') return { status: 'missing' };
        return { status: 'ok', raw };
    } catch (error) {
        if (missingKeyErrorDetector(error)) return { status: 'missing' };
        return { status: 'error', error };
    }
}

// ---------------- 基础校验 ----------------

function isInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

function requireSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new PageStoreError('INVALID_ARGUMENT', 'sessionId 不能为空');
    }
}

function requirePageNo(pageNo: number): void {
    if (!isInt(pageNo) || pageNo < 1) {
        throw new PageStoreError('INVALID_ARGUMENT', `非法页号 ${String(pageNo)}（应为 ≥1 的整数）`, isInt(pageNo) ? pageNo : undefined);
    }
}

function invalidPageError(pageNo: number, detail: string): PageStoreError {
    return new PageStoreError('INVALID_PAGE', `事件页 ${pageNo} 校验失败：${detail}`, pageNo);
}

const EVENT_KINDS = ['user', 'assistant', 'tool_call', 'tool_result', 'event'];

function requireStringField(obj: Record<string, unknown>, key: string, label: string, pageNo: number): void {
    if (typeof obj[key] !== 'string') throw invalidPageError(pageNo, `${label}.${key} 应为字符串`);
}

function requireArrayField(obj: Record<string, unknown>, key: string, label: string, pageNo: number): void {
    if (!Array.isArray(obj[key])) throw invalidPageError(pageNo, `${label}.${key} 应为数组`);
}

function requireOptionalStringField(obj: Record<string, unknown>, key: string, label: string, pageNo: number): void {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') throw invalidPageError(pageNo, `${label}.${key} 应为字符串或省略`);
}

/** 事件结构校验（只做存储完整性的最小校验；Part 内部语义由 content/validate 负责） */
function validateEventRecord(event: unknown, index: number, pageNo: number): ConversationEvent {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw invalidPageError(pageNo, `events[${index}] 不是对象`);
    const ev = event as Record<string, unknown>;
    const label = `events[${index}]`;
    if (!isInt(ev.seq) || ev.seq < 1) throw invalidPageError(pageNo, `${label}.seq 非法`);
    if (typeof ev.eventId !== 'string' || ev.eventId.length === 0) throw invalidPageError(pageNo, `${label}.eventId 为空`);
    if (typeof ev.at !== 'number' || !Number.isFinite(ev.at)) throw invalidPageError(pageNo, `${label}.at 非法`);
    if (typeof ev.recvAt !== 'number' || !Number.isFinite(ev.recvAt)) throw invalidPageError(pageNo, `${label}.recvAt 非法`);
    if (typeof ev.kind !== 'string' || !EVENT_KINDS.includes(ev.kind)) {
        throw invalidPageError(pageNo, `${label}.kind 未知（${String(ev.kind)}）`);
    }
    switch (ev.kind) {
        case 'user':
            requireStringField(ev, 'uid', label, pageNo);
            requireStringField(ev, 'msgId', label, pageNo);
            requireArrayField(ev, 'parts', label, pageNo);
            break;
        case 'assistant':
            requireStringField(ev, 'msgId', label, pageNo);
            requireArrayField(ev, 'parts', label, pageNo);
            requireOptionalStringField(ev, 'reasoning', label, pageNo);
            break;
        case 'tool_call':
            requireStringField(ev, 'turnId', label, pageNo);
            requireStringField(ev, 'groupId', label, pageNo);
            requireStringField(ev, 'callId', label, pageNo);
            requireStringField(ev, 'name', label, pageNo);
            requireStringField(ev, 'args', label, pageNo);
            requireOptionalStringField(ev, 'reasoning', label, pageNo);
            break;
        case 'tool_result':
            requireStringField(ev, 'turnId', label, pageNo);
            requireStringField(ev, 'groupId', label, pageNo);
            requireStringField(ev, 'callId', label, pageNo);
            requireArrayField(ev, 'parts', label, pageNo);
            requireOptionalStringField(ev, 'name', label, pageNo);
            break;
        case 'event':
            requireStringField(ev, 'systemName', label, pageNo);
            requireArrayField(ev, 'parts', label, pageNo);
            break;
        default:
            break;
    }
    return event as ConversationEvent;
}

function stringifyOrThrow(value: unknown, pageNo: number, label: string): string {
    try {
        return JSON.stringify(value);
    } catch (error) {
        throw new PageStoreError('INVALID_PAGE', `${label} 无法序列化（${describeStorageError(error)}）`, pageNo);
    }
}

// ---------------- 页构造 / 序列化 ----------------

/** 写入用的事件页输入：seqStart/seqEnd/bytes 由 store 从 events 推导 */
export interface EventPageInput {
    pageNo: number;
    events: ConversationEvent[];
}

/** 页负载字节数（不含 bytes 字段本身；确定可复算，用于自描述校验与 32KB 上限） */
export function measureEventPageBytes(page: Pick<EventPage, 'pageNo' | 'seqStart' | 'seqEnd' | 'events'>): number {
    return JSON.stringify({
        pageNo: page.pageNo,
        seqStart: page.seqStart,
        seqEnd: page.seqEnd,
        events: page.events,
    }).length;
}

/**
 * 构造/校验一张事件页：校验事件结构、seq 连续、条数与字节上限，并计算自描述字段。
 * 调用方负责切片（本函数不拆分页）；不合法时抛 PageStoreError。
 */
export function buildEventPage(pageNo: number, events: ConversationEvent[]): EventPage {
    requirePageNo(pageNo);
    if (!Array.isArray(events) || events.length === 0) {
        throw new PageStoreError('INVALID_ARGUMENT', `事件页 ${pageNo} 不能为空`, pageNo);
    }
    if (events.length > EVENT_PAGE_MAX_EVENTS) {
        throw new PageStoreError('INVALID_ARGUMENT', `事件页 ${pageNo} 超过单页上限 ${EVENT_PAGE_MAX_EVENTS} 条（实际 ${events.length}）`, pageNo);
    }
    const copied: ConversationEvent[] = [];
    let expectedSeq: number | null = null;
    for (let index = 0; index < events.length; index += 1) {
        const event = validateEventRecord(events[index], index, pageNo);
        if (expectedSeq === null) {
            expectedSeq = event.seq;
        } else if (event.seq !== expectedSeq) {
            throw invalidPageError(pageNo, `seq 不连续：events[${index}].seq=${event.seq}，期望 ${expectedSeq}`);
        }
        expectedSeq += 1;
        copied.push(event);
    }
    const page: EventPage = {
        pageNo,
        seqStart: copied[0].seq,
        seqEnd: copied[copied.length - 1].seq,
        bytes: 0,
        events: copied,
    };
    page.bytes = measureEventPageBytes(page);
    if (page.bytes > EVENT_PAGE_MAX_BYTES) {
        throw new PageStoreError('INVALID_ARGUMENT', `事件页 ${pageNo} 负载 ${page.bytes} 字节超过上限 ${EVENT_PAGE_MAX_BYTES}`, pageNo);
    }
    // 提前暴露不可序列化的数据（raw/parts 里可能有循环引用），写入时不再二次抛未知异常
    stringifyOrThrow(page, pageNo, `事件页 ${pageNo}`);
    return page;
}

/** 解析 + 校验一张从存储读出的页（含 pageNo 匹配、seq 连续、bytes 自描述一致） */
function parseEventPage(raw: string, pageNo: number): EventPage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw invalidPageError(pageNo, `JSON 解析失败（${describeStorageError(error)}）`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidPageError(pageNo, '顶层不是对象');
    const data = parsed as Record<string, unknown>;
    if (!isInt(data.pageNo) || data.pageNo !== pageNo) {
        throw invalidPageError(pageNo, `pageNo 不匹配（存 ${String(data.pageNo)}，期望 ${pageNo}）`);
    }
    if (!Array.isArray(data.events) || data.events.length === 0) throw invalidPageError(pageNo, 'events 非数组或为空');
    if (data.events.length > EVENT_PAGE_MAX_EVENTS) {
        throw invalidPageError(pageNo, `events 超过上限 ${EVENT_PAGE_MAX_EVENTS} 条`);
    }
    if (!isInt(data.seqStart) || data.seqStart < 1) throw invalidPageError(pageNo, 'seqStart 非法');
    if (!isInt(data.seqEnd) || data.seqEnd < data.seqStart) throw invalidPageError(pageNo, 'seqEnd 非法');
    if (typeof data.bytes !== 'number' || !Number.isFinite(data.bytes) || data.bytes < 0) throw invalidPageError(pageNo, 'bytes 非法');
    const events = data.events.map((event, index) => validateEventRecord(event, index, pageNo));
    if (events[0].seq !== data.seqStart) throw invalidPageError(pageNo, 'seqStart 与 events[0].seq 不一致');
    if (events[events.length - 1].seq !== data.seqEnd) throw invalidPageError(pageNo, 'seqEnd 与末条事件 seq 不一致');
    for (let index = 1; index < events.length; index += 1) {
        if (events[index].seq !== events[index - 1].seq + 1) {
            throw invalidPageError(pageNo, `events seq 不连续（events[${index}].seq=${events[index].seq}）`);
        }
    }
    const page: EventPage = {
        pageNo,
        seqStart: data.seqStart,
        seqEnd: data.seqEnd,
        bytes: data.bytes,
        events,
    };
    const measured = measureEventPageBytes(page);
    if (measured !== data.bytes) throw invalidPageError(pageNo, `bytes 自描述不一致（存 ${data.bytes}，实算 ${measured}）`);
    if (measured > EVENT_PAGE_MAX_BYTES) throw invalidPageError(pageNo, `负载 ${measured} 字节超过上限 ${EVENT_PAGE_MAX_BYTES}`);
    return page;
}

// ---------------- 读 ----------------

/**
 * 读一张事件页。
 * @returns 页对象；key 缺失/已被清理返回 `null`。
 * @throws PageStoreError code=READ_FAILED（存储读失败，非缺失）或 INVALID_PAGE（页损坏，含半页）
 */
export function readEventPage(sessionId: string, pageNo: number): EventPage | null {
    requireSessionId(sessionId);
    requirePageNo(pageNo);
    const probe = probeStoredString(eventPageKey(sessionId, pageNo));
    if (probe.status === 'missing') return null;
    if (probe.status === 'error') {
        throw new PageStoreError('READ_FAILED', `事件页读取失败（pageNo=${pageNo}）：${describeStorageError(probe.error)}`, pageNo);
    }
    return parseEventPage(probe.raw, pageNo);
}

/** 批量读页 [fromPageNo, toPageNo]（闭区间）：缺失页记录到 missingPageNos；读失败直接抛（不静默跳） */
export interface EventPageRangeResult {
    pages: EventPage[];
    missingPageNos: number[];
}

export function readEventPages(sessionId: string, fromPageNo: number, toPageNo: number): EventPageRangeResult {
    requireSessionId(sessionId);
    requirePageNo(fromPageNo);
    requirePageNo(toPageNo);
    if (toPageNo < fromPageNo) {
        throw new PageStoreError('INVALID_ARGUMENT', `页号区间非法：${fromPageNo}..${toPageNo}`);
    }
    const pages: EventPage[] = [];
    const missingPageNos: number[] = [];
    for (let pageNo = fromPageNo; pageNo <= toPageNo; pageNo += 1) {
        const page = readEventPage(sessionId, pageNo);
        if (page) {
            pages.push(page);
        } else {
            missingPageNos.push(pageNo);
        }
    }
    return { pages, missingPageNos };
}

// ---------------- 写 ----------------

/**
 * 写一张事件页（只写一次）。
 * 已存在：校验既有页可解析且 seq 范围一致 → 'exists'（不重写、不覆盖）。
 * 写失败：返回 'failed'（调用方保留数据、下次重试），不抛。
 * 既有页损坏 / seq 范围冲突：抛 PageStoreError（不覆盖，交上层修复）。
 */
export function writeEventPage(sessionId: string, page: EventPageInput): WritePageResult {
    requireSessionId(sessionId);
    const built = buildEventPage(page.pageNo, page.events);
    const key = eventPageKey(sessionId, built.pageNo);
    const probe = probeStoredString(key);
    if (probe.status === 'ok') {
        const existing = parseEventPage(probe.raw, built.pageNo);
        if (existing.seqStart !== built.seqStart || existing.seqEnd !== built.seqEnd) {
            throw new PageStoreError(
                'INVALID_PAGE',
                `事件页 ${built.pageNo} 已存在且 seq 范围不同（既有 ${existing.seqStart}-${existing.seqEnd}，写入 ${built.seqStart}-${built.seqEnd}），拒绝覆盖`,
                built.pageNo,
            );
        }
        return 'exists';
    }
    if (probe.status === 'error') return 'failed';   // 读探测失败：不冒险覆盖，交上层重试
    try {
        getHost().storage.set(key, stringifyOrThrow(built, built.pageNo, `事件页 ${built.pageNo}`));
        return 'written';
    } catch {
        return 'failed';
    }
}

/** 批量写页：按顺序写，遇失败立即停止并返回失败页号（调用方保留该页及之后的数据重试） */
export function writeEventPages(sessionId: string, pages: EventPageInput[]): EventPageBatchWriteResult {
    requireSessionId(sessionId);
    if (!Array.isArray(pages)) throw new PageStoreError('INVALID_ARGUMENT', 'pages 应为数组');
    const result: EventPageBatchWriteResult = { written: 0, exists: 0 };
    for (const page of pages) {
        const outcome = writeEventPage(sessionId, page);
        if (outcome === 'failed') {
            result.failedPageNo = page.pageNo;
            return result;
        }
        if (outcome === 'written') result.written += 1;
        else result.exists += 1;
    }
    return result;
}

// ---------------- 恢复探测 ----------------

/** 恢复起点：取 head 的 nextPageNo / persistedSeq（head 可能落后于已写页，正是要探测的场景） */
export interface EventRecoveryStart {
    nextPageNo: number;
    persistedSeq: number;
}

export interface EventRecoveryResult {
    /** 按页号升序采纳的连续页 */
    pages: EventPage[];
    /** 恢复后的新 head 数值：下一个待写页号 */
    nextPageNo: number;
    /** 恢复后的新 head 数值：已成功落盘到的 seq */
    persistedSeq: number;
    /** missing=遇到缺失页（正常尾部）；limit=达到单次采纳上限（未探测完，可再次调用） */
    stoppedBy: 'missing' | 'limit';
}

/**
 * 恢复探测：从 `head.nextPageNo` 开始逐页读，遇到缺失停止。
 * 用于"页已写、head 未推进"的崩溃恢复（head 最多落后一个 flush 批次）。
 * 页号不匹配 / seq 不连续视为数据损坏，抛 INVALID_PAGE（不静默跳过，避免把坏页当尾部）。
 */
export function recoverEventPages(
    sessionId: string,
    head: EventRecoveryStart,
    options: { maxPages?: number } = {},
): EventRecoveryResult {
    requireSessionId(sessionId);
    if (!isInt(head.nextPageNo) || head.nextPageNo < 1) {
        throw new PageStoreError('INVALID_ARGUMENT', `恢复起点 nextPageNo 非法（${String(head.nextPageNo)}）`);
    }
    if (!isInt(head.persistedSeq) || head.persistedSeq < 0) {
        throw new PageStoreError('INVALID_ARGUMENT', `恢复起点 persistedSeq 非法（${String(head.persistedSeq)}）`);
    }
    const maxPages = options.maxPages === undefined ? EVENT_RECOVERY_MAX_PAGES : options.maxPages;
    if (!isInt(maxPages) || maxPages < 1) {
        throw new PageStoreError('INVALID_ARGUMENT', `恢复上限 maxPages 非法（${String(maxPages)}）`);
    }

    const pages: EventPage[] = [];
    let pageNo = head.nextPageNo;
    let expectedSeq = head.persistedSeq + 1;
    while (pages.length < maxPages) {
        const page = readEventPage(sessionId, pageNo);
        if (!page) {
            return { pages, nextPageNo: pageNo, persistedSeq: expectedSeq - 1, stoppedBy: 'missing' };
        }
        if (page.seqStart !== expectedSeq) {
            throw new PageStoreError(
                'INVALID_PAGE',
                `恢复探测 seq 不连续：页 ${pageNo} seqStart=${page.seqStart}，期望 ${expectedSeq}`,
                pageNo,
            );
        }
        pages.push(page);
        expectedSeq = page.seqEnd + 1;
        pageNo += 1;
    }
    return { pages, nextPageNo: pageNo, persistedSeq: expectedSeq - 1, stoppedBy: 'limit' };
}
