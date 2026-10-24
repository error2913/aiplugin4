// 旧会话迁移的持久化步骤（纯编排：buildLegacyEvents → 写页 → 最后写 head）。
// 幂等：head 已存在直接跳过；中断后重跑时已有页返回 exists，不会重复内容。
import { getHost } from "../../core/host";
import { parseText } from "../content/text_parse";
import {
    ConversationEvent,
    Part,
    RecordEntry,
} from "../events";
import {
    ContextHead,
    createEmptyHead,
    parseHead,
    serializeHead,
} from "../head";
import { headKey } from "../keys";
import { buildEventPage, measureEventPageBytes, writeEventPages } from "../log/page_store";
import { buildRecordPage, loadRecordPages, measureRecordPageBytes, writeRecordPages } from "../log/record_store";

import { buildLegacyEvents, LegacyContextLike } from "./v1";

const EVENT_PAGE_MAX_BYTES = 32 * 1024;
const EVENT_PAGE_MAX_EVENTS = 256;
const RECORD_PAGE_MAX_BYTES = 32 * 1024;
const RECORD_PAGE_MAX_ENTRIES = 256;

export interface MigratePersistOptions {
    /** 未摘要 token 估算（注入；缺省 0，之后由 compactor 重新校准） */
    estimateEventTokens?: (event: ConversationEvent) => number;
    /** 是否把历史文本里的标签解析为 Part（默认用 content/text_parse 的 user/internal） */
    parseText?: (text: string, mode: 'user' | 'internal') => Part[];
    /** 已存在 head 时是否强制重跑（默认 false=幂等跳过） */
    force?: boolean;
}

export interface MigratePersistResult {
    migrated: boolean;
    head: ContextHead;
    events: number;
    records: number;
    pages: number;
    recordPages: number;
}

function chunkEvents(events: ConversationEvent[]): ConversationEvent[][] {
    const chunks: ConversationEvent[][] = [];
    let current: ConversationEvent[] = [];
    for (const event of events) {
        const candidate = current.concat([event]);
        const bytes = measureEventPageBytes({
            pageNo: 1,
            seqStart: candidate[0].seq,
            seqEnd: candidate[candidate.length - 1].seq,
            events: candidate,
        });
        if (current.length > 0 && (candidate.length > EVENT_PAGE_MAX_EVENTS || bytes > EVENT_PAGE_MAX_BYTES)) {
            chunks.push(current);
            current = [event];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function chunkRecords(records: RecordEntry[]): RecordEntry[][] {
    const chunks: RecordEntry[][] = [];
    let current: RecordEntry[] = [];
    for (const record of records) {
        const candidate = current.concat([record]);
        const bytes = measureRecordPageBytes({ pageNo: 1, entries: candidate });
        if (current.length > 0 && (candidate.length > RECORD_PAGE_MAX_ENTRIES || bytes > RECORD_PAGE_MAX_BYTES)) {
            chunks.push(current);
            current = [record];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** 只读判断是否已经迁移（head 存在） */
export function isMigrated(sessionId: string): boolean {
    try {
        const raw = getHost().storage.get(headKey(sessionId));
        return !!parseHead(raw);
    } catch {
        return false;
    }
}

/**
 * 旧会话 → v2 持久化。
 * 顺序：事件页 → 记录页 → head（最后）。任何一步失败都不写 head，重跑幂等。
 */
export function migrateLegacySession(
    sessionId: string,
    legacy: LegacyContextLike,
    opts: MigratePersistOptions = {},
): MigratePersistResult {
    if (!opts.force && isMigrated(sessionId)) {
        const current = parseHead(getHost().storage.get(headKey(sessionId)));
        return {
            migrated: false,
            head: current ?? createEmptyHead(),
            events: 0,
            records: 0,
            pages: 0,
            recordPages: 0,
        };
    }

    const build = buildLegacyEvents(legacy, {
        parseText: opts.parseText ?? ((text, mode) => parseText(text, mode)),
    });

    const eventChunks = chunkEvents(build.events);
    const recordChunks = chunkRecords(build.records);

    let bytesTotal = 0;
    let pageNo = 1;
    for (const chunk of eventChunks) {
        const page = buildEventPage(pageNo, chunk);
        const result = writeEventPages(sessionId, [{ pageNo, events: page.events }]);
        if (result.failedPageNo !== undefined) {
            throw new Error(`迁移事件页写入失败: page ${result.failedPageNo}`);
        }
        bytesTotal += page.bytes;
        pageNo++;
    }

    let recPageNo = 1;
    for (const chunk of recordChunks) {
        const page = buildRecordPage(recPageNo, chunk);
        const result = writeRecordPages(sessionId, [{ pageNo: recPageNo, entries: page.entries }]);
        if (result.failedPageNo !== undefined) {
            throw new Error(`迁移记录页写入失败: page ${result.failedPageNo}`);
        }
        bytesTotal += page.bytes;
        recPageNo++;
    }

    const head = createEmptyHead();
    head.epoch = 1;
    head.epochStartSeq = 1;
    head.nextSeq = build.nextSeq;
    head.persistedSeq = Math.max(0, build.events.length);
    head.nextPageNo = pageNo;
    head.pageFloor = 1;
    head.nextRecPageNo = recPageNo;
    head.recFloor = 1;
    head.summarizedThrough = 0;
    head.unsummarizedTokens = opts.estimateEventTokens
        ? build.events.reduce((n, e) => n + Math.max(0, opts.estimateEventTokens!(e)), 0)
        : 0;
    head.bytesTotal = bytesTotal;
    head.legacy = build.legacyIndex;

    getHost().storage.set(headKey(sessionId), serializeHead(head));

    return {
        migrated: true,
        head,
        events: build.events.length,
        records: build.records.length,
        pages: eventChunks.length,
        recordPages: recordChunks.length,
    };
}

/** 加载迁移后的记录页数量（测试/诊断用） */
export function countMigratedRecordPages(sessionId: string, head: ContextHead): number {
    const loaded = loadRecordPages(sessionId, { recFloor: head.recFloor, nextRecPageNo: head.nextRecPageNo }, { maxPages: 256 });
    return loaded.pages.length;
}
