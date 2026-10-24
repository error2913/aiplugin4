// Context v2 记录页存储（rec:<sid>:<pageNo>）：summary / edit / supersede / redact / epoch 统一放这里。
//
// 契约（.dev/context-v2-design.md §4、context-v2-implementation-plan.md §3.1/§4.4）：
// - 只追加、页只写一次、页号连续；记录页自描述（pageNo/bytes/entries）。
// - 加载全部记录页 → 记录数组（页号升序 + 页内顺序），供上层建索引；不在这里做可见性/摘要选择。
// - 存储只走 getHost().storage；缺失归一为 null，读失败抛 PageStoreError 由上层决定。
// - `bytes` 口径与事件页一致：entries 负载（不含 bytes 字段本身）的 JSON 序列化长度。
import { getHost } from '../../core/host';
import type { RecordEntry, RecordPage } from '../events';
import { recordPageKey } from '../keys';

import { describeStorageError, PageStoreError, probeStoredString, type WritePageResult } from './page_store';

/** 单记录页条目上限（调用方切片，store 只校验） */
export const RECORD_PAGE_MAX_ENTRIES = 256;
/** 单记录页负载字节上限（调用方切片，store 只校验） */
export const RECORD_PAGE_MAX_BYTES = 32 * 1024;
/** 记录页批量加载单次最多扫描页数：未加载完可带 nextRecPageNo 继续 */
export const RECORD_LOAD_MAX_PAGES = 256;

const RECORD_KINDS = ['summary', 'edit', 'supersede', 'redact', 'epoch'];
const REDACT_TARGETS = ['user', 'assistant', 'all'];

/** 写入用的记录页输入：bytes 由 store 推导 */
export interface RecordPageInput {
    pageNo: number;
    entries: RecordEntry[];
}

/** 记录页批量写入结果：遇 failed 立即停止（后续页由调用方保留重试） */
export interface RecordPageBatchWriteResult {
    written: number;
    exists: number;
    /** 第一张写失败的页号（undefined=全部成功） */
    failedPageNo?: number;
}

/** 记录页全量加载结果（未来记录索引的输入） */
export interface RecordLoadResult {
    /** 页号升序的记录页 */
    pages: RecordPage[];
    /** 页号升序 + 页内顺序的记录数组 */
    entries: RecordEntry[];
    /** 区间内缺失（被清理/未写）的页号；读失败会直接抛，不会出现在这里 */
    missingPageNos: number[];
    /** 下一次继续加载的页号（= 已扫描到的最后页号 + 1） */
    nextRecPageNo: number;
    /** end=扫描到 nextRecPageNo-1；limit=达到单次扫描上限，可带 nextRecPageNo 继续 */
    stoppedBy: 'end' | 'limit';
}

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
        throw new PageStoreError('INVALID_ARGUMENT', `非法记录页号 ${String(pageNo)}（应为 ≥1 的整数）`, isInt(pageNo) ? pageNo : undefined);
    }
}

function invalidRecordPageError(pageNo: number, detail: string): PageStoreError {
    return new PageStoreError('INVALID_PAGE', `记录页 ${pageNo} 校验失败：${detail}`, pageNo);
}

function requireStringField(obj: Record<string, unknown>, key: string, label: string, pageNo: number, allowEmpty = false): void {
    if (typeof obj[key] !== 'string' || (!allowEmpty && (obj[key] as string).length === 0)) {
        throw invalidRecordPageError(pageNo, `${label}.${key} 应为${allowEmpty ? '' : '非空'}字符串`);
    }
}

function requireIntField(obj: Record<string, unknown>, key: string, min: number, label: string, pageNo: number): number {
    const value = obj[key];
    if (!isInt(value) || value < min) throw invalidRecordPageError(pageNo, `${label}.${key} 应为 ≥${min} 的整数`);
    return value;
}

function stringifyOrThrow(value: unknown, pageNo: number, label: string): string {
    try {
        return JSON.stringify(value);
    } catch (error) {
        throw new PageStoreError('INVALID_PAGE', `${label} 无法序列化（${describeStorageError(error)}）`, pageNo);
    }
}

/** 记录结构校验（类型层已保证；这里防存储损坏/手写脏数据，只校验最关键的判别字段） */
function validateRecordEntry(entry: unknown, index: number, pageNo: number): RecordEntry {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw invalidRecordPageError(pageNo, `entries[${index}] 不是对象`);
    }
    const rec = entry as Record<string, unknown>;
    const label = `entries[${index}]`;
    requireStringField(rec, 'id', label, pageNo);
    if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) throw invalidRecordPageError(pageNo, `${label}.at 非法`);
    if (typeof rec.kind !== 'string' || !RECORD_KINDS.includes(rec.kind)) {
        throw invalidRecordPageError(pageNo, `${label}.kind 未知（${String(rec.kind)}）`);
    }
    switch (rec.kind) {
        case 'summary': {
            requireIntField(rec, 'epoch', 1, label, pageNo);
            const fromSeq = requireIntField(rec, 'fromSeq', 1, label, pageNo);
            const toSeq = requireIntField(rec, 'toSeq', 1, label, pageNo);
            if (toSeq < fromSeq) throw invalidRecordPageError(pageNo, `${label}.toSeq 小于 fromSeq`);
            requireStringField(rec, 'text', label, pageNo, true);
            if (rec.model !== undefined && typeof rec.model !== 'string') throw invalidRecordPageError(pageNo, `${label}.model 应为字符串或省略`);
            if (rec.promptVersion !== undefined && !isInt(rec.promptVersion)) throw invalidRecordPageError(pageNo, `${label}.promptVersion 应为整数或省略`);
            break;
        }
        case 'edit': {
            requireIntField(rec, 'seq', 1, label, pageNo);
            if (!Array.isArray(rec.parts)) throw invalidRecordPageError(pageNo, `${label}.parts 应为数组`);
            break;
        }
        case 'supersede': {
            requireStringField(rec, 'dedupKey', label, pageNo);
            requireIntField(rec, 'seq', 1, label, pageNo);
            break;
        }
        case 'redact': {
            requireIntField(rec, 'epoch', 1, label, pageNo);
            const fromSeq = requireIntField(rec, 'fromSeq', 1, label, pageNo);
            const toSeq = requireIntField(rec, 'toSeq', 1, label, pageNo);
            if (toSeq < fromSeq) throw invalidRecordPageError(pageNo, `${label}.toSeq 小于 fromSeq`);
            if (typeof rec.target !== 'string' || !REDACT_TARGETS.includes(rec.target)) {
                throw invalidRecordPageError(pageNo, `${label}.target 应为 user/assistant/all`);
            }
            break;
        }
        case 'epoch': {
            requireIntField(rec, 'epoch', 1, label, pageNo);
            requireIntField(rec, 'startSeq', 1, label, pageNo);
            break;
        }
        default:
            break;
    }
    return entry as RecordEntry;
}

/** 记录页负载字节数（不含 bytes 字段本身；确定可复算） */
export function measureRecordPageBytes(page: Pick<RecordPage, 'pageNo' | 'entries'>): number {
    return JSON.stringify({ pageNo: page.pageNo, entries: page.entries }).length;
}

/**
 * 构造/校验一张记录页：校验记录结构、条数与字节上限，并计算自描述字段。
 * 调用方负责切片（本函数不拆分页）；不合法时抛 PageStoreError。
 */
export function buildRecordPage(pageNo: number, entries: RecordEntry[]): RecordPage {
    requirePageNo(pageNo);
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new PageStoreError('INVALID_ARGUMENT', `记录页 ${pageNo} 不能为空`, pageNo);
    }
    if (entries.length > RECORD_PAGE_MAX_ENTRIES) {
        throw new PageStoreError('INVALID_ARGUMENT', `记录页 ${pageNo} 超过单页上限 ${RECORD_PAGE_MAX_ENTRIES} 条（实际 ${entries.length}）`, pageNo);
    }
    const copied: RecordEntry[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        copied.push(validateRecordEntry(entries[index], index, pageNo));
    }
    const page: RecordPage = { pageNo, bytes: 0, entries: copied };
    page.bytes = measureRecordPageBytes(page);
    if (page.bytes > RECORD_PAGE_MAX_BYTES) {
        throw new PageStoreError('INVALID_ARGUMENT', `记录页 ${pageNo} 负载 ${page.bytes} 字节超过上限 ${RECORD_PAGE_MAX_BYTES}`, pageNo);
    }
    stringifyOrThrow(page, pageNo, `记录页 ${pageNo}`);
    return page;
}

/** 解析 + 校验一张从存储读出的记录页（含 pageNo 匹配、bytes 自描述一致） */
function parseRecordPage(raw: string, pageNo: number): RecordPage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw invalidRecordPageError(pageNo, `JSON 解析失败（${describeStorageError(error)}）`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidRecordPageError(pageNo, '顶层不是对象');
    const data = parsed as Record<string, unknown>;
    if (!isInt(data.pageNo) || data.pageNo !== pageNo) {
        throw invalidRecordPageError(pageNo, `pageNo 不匹配（存 ${String(data.pageNo)}，期望 ${pageNo}）`);
    }
    if (!Array.isArray(data.entries) || data.entries.length === 0) throw invalidRecordPageError(pageNo, 'entries 非数组或为空');
    if (data.entries.length > RECORD_PAGE_MAX_ENTRIES) {
        throw invalidRecordPageError(pageNo, `entries 超过上限 ${RECORD_PAGE_MAX_ENTRIES} 条`);
    }
    if (typeof data.bytes !== 'number' || !Number.isFinite(data.bytes) || data.bytes < 0) throw invalidRecordPageError(pageNo, 'bytes 非法');
    const entries = data.entries.map((entry, index) => validateRecordEntry(entry, index, pageNo));
    const page: RecordPage = { pageNo, bytes: data.bytes, entries };
    const measured = measureRecordPageBytes(page);
    if (measured !== data.bytes) throw invalidRecordPageError(pageNo, `bytes 自描述不一致（存 ${data.bytes}，实算 ${measured}）`);
    if (measured > RECORD_PAGE_MAX_BYTES) throw invalidRecordPageError(pageNo, `负载 ${measured} 字节超过上限 ${RECORD_PAGE_MAX_BYTES}`);
    return page;
}

/**
 * 读一张记录页。
 * @returns 页对象；key 缺失/已被清理返回 `null`。
 * @throws PageStoreError code=READ_FAILED（存储读失败，非缺失）或 INVALID_PAGE（页损坏，含半页）
 */
export function readRecordPage(sessionId: string, pageNo: number): RecordPage | null {
    requireSessionId(sessionId);
    requirePageNo(pageNo);
    const probe = probeStoredString(recordPageKey(sessionId, pageNo));
    if (probe.status === 'missing') return null;
    if (probe.status === 'error') {
        throw new PageStoreError('READ_FAILED', `记录页读取失败（pageNo=${pageNo}）：${describeStorageError(probe.error)}`, pageNo);
    }
    return parseRecordPage(probe.raw, pageNo);
}

/**
 * 写一张记录页（只写一次）。
 * 已存在 → 校验既有页可解析后返回 'exists'（不重写）。
 * 写失败 → 'failed'（调用方保留数据重试）。既有页损坏 → 抛 INVALID_PAGE（不覆盖）。
 */
export function writeRecordPage(sessionId: string, page: RecordPageInput): WritePageResult {
    requireSessionId(sessionId);
    const built = buildRecordPage(page.pageNo, page.entries);
    const key = recordPageKey(sessionId, built.pageNo);
    const probe = probeStoredString(key);
    if (probe.status === 'ok') {
        parseRecordPage(probe.raw, built.pageNo);
        return 'exists';
    }
    if (probe.status === 'error') return 'failed';
    try {
        getHost().storage.set(key, stringifyOrThrow(built, built.pageNo, `记录页 ${built.pageNo}`));
        return 'written';
    } catch {
        return 'failed';
    }
}

/** 批量写记录页：按顺序写，遇失败立即停止并返回失败页号 */
export function writeRecordPages(sessionId: string, pages: RecordPageInput[]): RecordPageBatchWriteResult {
    requireSessionId(sessionId);
    if (!Array.isArray(pages)) throw new PageStoreError('INVALID_ARGUMENT', 'pages 应为数组');
    const result: RecordPageBatchWriteResult = { written: 0, exists: 0 };
    for (const page of pages) {
        const outcome = writeRecordPage(sessionId, page);
        if (outcome === 'failed') {
            result.failedPageNo = page.pageNo;
            return result;
        }
        if (outcome === 'written') result.written += 1;
        else result.exists += 1;
    }
    return result;
}

/**
 * 加载记录页到记录数组（未来索引入口）：
 * 扫描 head.recFloor .. head.nextRecPageNo-1；缺失页记录但不中断（recFloor 只在清页成功后推进，
 * 区间内缺失通常意味着清理/崩溃，上层可据此触发 repair）；读失败直接抛。
 */
export function loadRecordPages(
    sessionId: string,
    head: { recFloor: number; nextRecPageNo: number },
    options: { maxPages?: number } = {},
): RecordLoadResult {
    requireSessionId(sessionId);
    if (!isInt(head.recFloor) || head.recFloor < 1) {
        throw new PageStoreError('INVALID_ARGUMENT', `recFloor 非法（${String(head.recFloor)}）`);
    }
    if (!isInt(head.nextRecPageNo) || head.nextRecPageNo < 1) {
        throw new PageStoreError('INVALID_ARGUMENT', `nextRecPageNo 非法（${String(head.nextRecPageNo)}）`);
    }
    const maxPages = options.maxPages === undefined ? RECORD_LOAD_MAX_PAGES : options.maxPages;
    if (!isInt(maxPages) || maxPages < 1) {
        throw new PageStoreError('INVALID_ARGUMENT', `记录页加载上限 maxPages 非法（${String(maxPages)}）`);
    }

    const fromPageNo = Math.max(1, head.recFloor);
    const lastPageNo = head.nextRecPageNo - 1;
    const pages: RecordPage[] = [];
    const entries: RecordEntry[] = [];
    const missingPageNos: number[] = [];
    let pageNo = fromPageNo;
    let scanned = 0;
    while (pageNo <= lastPageNo && scanned < maxPages) {
        const page = readRecordPage(sessionId, pageNo);
        if (page) {
            pages.push(page);
            for (const entry of page.entries) entries.push(entry);
        } else {
            missingPageNos.push(pageNo);
        }
        pageNo += 1;
        scanned += 1;
    }
    return {
        pages,
        entries,
        missingPageNos,
        nextRecPageNo: pageNo,
        stoppedBy: pageNo > lastPageNo ? 'end' : 'limit',
    };
}
