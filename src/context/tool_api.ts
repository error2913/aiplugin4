// read_raw / grep_raw 的工具适配层：把工具参数映射到 recall，并格式化为模型可读文本。
// 只做参数/格式化，不注册工具；工具层（tool_raw）在 P3 切换时调用这里。
import type { GrepRawResult, ReadCursor, ReadRawResult } from "./recall";
import type { ContextService } from "./service";

export interface ReadRawToolParams {
    /** e:<seq> / e:<from>-<to> / msgId / blk:<id> / arc:<seq> / raw:<seq> */
    id?: string;
    /** 旧工具参数名兼容：kind=user 时 id 可能是 msgId/blk: */
    kind?: string;
    limit?: number;
    max_chars?: number;
    cursor?: string;
}

export interface GrepRawToolParams {
    pattern?: string;
    regex?: boolean;
    from_seq?: number;
    to_seq?: number;
    max_pages?: number;
    max_hits?: number;
    cursor?: string;
    /** 事件发生时间下界（Unix 秒，闭区间；与 from_seq 语义独立） */
    time_from?: number;
    /** 事件发生时间上界（Unix 秒，闭区间） */
    time_to?: number;
    /** 发言人过滤（user 事件 uid，如 QQ:123） */
    from_uid?: string;
    /** 事件类型过滤（user/assistant/system/tool/event）；legacy 会话沿用旧 kind 语义 */
    kind?: string;
}

function intOrUndefined(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function boolOrFalse(value: unknown): boolean {
    return value === true || value === 'true' || value === '1' || value === 1;
}

/**
 * 工具的 kind 参数 → v2 事件 kind 列表。
 * 工具层面向模型暴露的是 user/assistant/system/tool/event 五个 token：
 * - `system` 对应账本里的 `event`（SystemEvent）；
 * - `tool` 对应 `tool_call`（工具调用事件）；
 * - 其余原样。
 * 单值字符串，保持 schema 简单；无法识别时返回 undefined（= 不过滤）。
 */
function normalizeV2Kinds(raw: unknown): string[] | undefined {
    const token = String(raw ?? '').trim().toLowerCase();
    if (!token) return undefined;
    const alias: Record<string, string> = { system: 'event', tool: 'tool_call', tool_result: 'tool_result' };
    const kind = alias[token] || token;
    return ['user', 'assistant', 'tool_call', 'tool_result', 'event'].includes(kind) ? [kind] : undefined;
}

export function parseReadCursor(raw: unknown): ReadCursor | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const m = /^(\d+):(\d+)$/.exec(raw.trim());
    if (!m) return null;
    return { seq: Number(m[1]), offset: Number(m[2]) };
}

export function formatReadCursor(cursor: ReadCursor | null | undefined): string {
    return cursor ? `${cursor.seq}:${cursor.offset}` : '';
}

/** 把工具参数归一为 readRaw 的地址和分页参数 */
export function normalizeReadParams(params: ReadRawToolParams): { address: string; maxItems: number; maxChars: number; cursor: ReadCursor | null } {
    const id = String(params.id ?? '').trim();
    if (!id) throw new Error('read_raw 缺少 id（可用 e:<seq> / e:<from>-<to> / msg_id / arc:<seq> / raw:<seq>）');
    const limit = Math.max(1, Math.min(50, intOrUndefined(params.limit) ?? 10));
    const maxChars = Math.max(200, Math.min(20000, intOrUndefined(params.max_chars) ?? 4000));
    return { address: id, maxItems: limit, maxChars, cursor: parseReadCursor(params.cursor) };
}

/** 工具适配层的时间格式化钩子（注入 fmtDate，避免 context 层依赖 Config/时区实现） */
export type RawTimeFormatter = (at: number) => string;

function fmtRawTime(formatTime: RawTimeFormatter | undefined, at: number): string {
    const value = Number(at);
    if (!Number.isFinite(value) || value <= 0) return '';
    try {
        return formatTime ? formatTime(value) : String(value);
    } catch {
        return String(value);
    }
}

/** 格式化 read_raw 结果（原文完整输出，带时间/消息 ID/寻址指针/游标） */
export function formatReadRawResult(result: ReadRawResult, formatTime?: RawTimeFormatter): string {
    const lines: string[] = [];
    const kindText = result.kind === 'events' ? '事件' : result.kind === 'legacy-shard' ? '旧分片' : result.kind === 'block' ? '旧块' : '未知';
    lines.push(`read_raw ${result.address}（${kindText}${typeof result.total === 'number' ? `，共 ${result.total} 条` : ''}）`);
    for (const item of result.items) {
        if (item.type === 'legacy') {
            lines.push(`[旧分片 index=${item.index} msg_id=${item.messageId} uid=${item.userId} time=${item.time}]`);
            lines.push(item.text);
        } else {
            const time = fmtRawTime(formatTime, item.at);
            const msgId = item.msgId ? ` msg_id=${item.msgId}` : '';
            lines.push(`[e:${item.seq} kind=${item.kind}${time ? ` time=${time}` : ''}${msgId}${item.offset ? ` offset=${item.offset}` : ''} event=${item.eventId}]`);
            lines.push(item.text);
        }
    }
    if (result.items.length === 0) lines.push('（该地址没有可见内容）');
    if (result.skippedPages.length > 0) lines.push(`（跳过坏页/缺页：${result.skippedPages.join(',')}）`);
    if (!result.exhausted && result.cursor) {
        lines.push(`[cursor=${formatReadCursor(result.cursor)}] 还有后续；继续读取请传 cursor=${formatReadCursor(result.cursor)}`);
    } else {
        lines.push('[已读完]');
    }
    if (result.note) lines.push(`（${result.note}）`);
    return lines.join('\n');
}

/** 格式化 grep_raw 结果（命中片段 + 时间/消息 ID + read_raw 指针 + 翻页游标） */
export function formatGrepRawResult(pattern: string, result: GrepRawResult, formatTime?: RawTimeFormatter): string {
    const lines: string[] = [];
    lines.push(`grep_raw ${pattern}：命中 ${result.hits.length} 条（本页按时间降序，最新在前）${result.exhausted ? '（已扫描完）' : '（还有更多，可传 cursor 继续）'}`);
    for (const hit of result.hits) {
        const time = fmtRawTime(formatTime, hit.at);
        const meta = `${time ? ` | ${time}` : ''}${hit.msgId ? ` | msg_id=${hit.msgId}` : ''}`;
        lines.push(`[e:${hit.seq} kind=${hit.kind}${meta}] ${hit.snippet}`);
        lines.push(`  → ${hit.pointer}`);
    }
    if (result.hits.length === 0) lines.push('（无命中）');
    if (result.nextCursor) {
        lines.push(`[cursor=${JSON.stringify(result.nextCursor)}] 继续搜索请原样传 cursor`);
    }
    return lines.join('\n');
}

/** 执行 read_raw（工具参数 → recall → 文本） */
export function readRawForTool(service: ContextService, params: ReadRawToolParams, formatTime?: RawTimeFormatter): string {
    const normalized = normalizeReadParams(params);
    const result = service.readRaw(normalized.address, {
        maxItems: normalized.maxItems,
        maxChars: normalized.maxChars,
        cursor: normalized.cursor,
    });
    return formatReadRawResult(result, formatTime);
}

/** 执行 grep_raw（工具参数 → recall → 文本） */
export function grepRawForTool(service: ContextService, params: GrepRawToolParams, formatTime?: RawTimeFormatter): string {
    const pattern = String(params.pattern ?? '');
    if (!pattern) throw new Error('grep_raw 缺少 pattern');
    let cursor: GrepRawResult['nextCursor'] = null;
    if (params.cursor) {
        try {
            cursor = JSON.parse(String(params.cursor));
        } catch {
            cursor = null;
        }
    }
    const result = service.grep(pattern, {
        regex: boolOrFalse(params.regex),
        fromSeq: intOrUndefined(params.from_seq),
        toSeq: intOrUndefined(params.to_seq),
        timeFrom: intOrUndefined(params.time_from),
        timeTo: intOrUndefined(params.time_to),
        fromUid: typeof params.from_uid === 'string' && params.from_uid.trim() ? params.from_uid.trim() : undefined,
        kinds: normalizeV2Kinds(params.kind),
        maxPages: intOrUndefined(params.max_pages),
        maxHits: intOrUndefined(params.max_hits),
        cursor,
    });
    return formatGrepRawResult(pattern, result, formatTime);
}
