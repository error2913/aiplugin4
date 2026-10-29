// 通用上下文引用解析工具：把模型看到的“表示”还原成原文/字段/元数据。
//
// 只读、无网络、默认不调 LLM：
// - e:<seq> / e:<from>-<to> / msg_id / read_raw 指针 → 事件原文（带时间/msg_id/游标）
// - [mem:<id>] → 记忆条目（事实/观察/心智模型；按当前可见 bank 搜索）
// - [img]/[avatar]/[record]/[video]/[file] → 原始字段（与 resolve_special_id 共用资源解析）
// - [quote] → 原始消息 ID + 同会话原文
// - [at]/[poke]/[forward]/[resource] → 昵称/原始 ID/URI
// - kind=event_raw + e:<seq> → system 事件原始 JSON
//
// 与 read_raw 的分工：read_raw 仍负责长区间/分页精读；本工具负责“复制表示 → 一次拿到具体信息”。
import { findEventBySeq, RecallError } from "../../../context/recall";
import {
    formatEventReadResult,
    formatMediaFields,
    formatMemoryRefHeader,
    parseContextRef,
    RESOLVE_EXTERNAL_NOTE,
    resolveError,
    resolveHeader,
} from "../../../context/resolve";
import type { ParsedContextRef, ResolveKindParam } from "../../../context/resolve";
import { parseReadCursor } from "../../../context/tool_api";
import { buildRecordIndex, isVisible } from "../../../context/view/records";
import { MemoryService } from "../../../memory/service";
import { resolveSpecialRef } from "../../../resource/resolve";
import type { Session } from "../../../session/session";
import User from "../../../session/user";
import { fmtDate } from "../../../utils/string";
import { getPlatform, normalizeUserId } from "../../../utils/target_id";
import Tool from "../../tool";
import { candidateMemoryBanks, resolveBank } from "../memory/shared";

const DEFAULT_MAX_CHARS = 4000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 12000;
const MAX_EVENT_ITEMS = 20;

interface ResolveArgs {
    ref?: unknown;
    kind?: unknown;
    max_chars?: unknown;
    cursor?: unknown;
    scope?: unknown;
    target_id?: unknown;
}

function intArg(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function stringArg(value: unknown): string {
    return String(value ?? '').trim();
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
    const value = String(text ?? '');
    if (value.length <= max) return { text: value, truncated: false };
    return { text: value.slice(0, max), truncated: true };
}

function errorText(code: string, message: string, hint?: string): string {
    return resolveError(code, message, hint);
}

/** 事件分支：e:/msg_id/read_raw 指针 */
function resolveEvent(session: Session, parsed: ParsedContextRef, maxChars: number, cursorRaw: unknown): string {
    const service = session.contextV2;
    if (!service) {
        return errorText('LEGACY_SESSION', 'This session has no v2 context ledger.', 'Use read_raw with legacy kind/id for old sessions.');
    }
    const address = parsed.address;
    if (!address) return errorText('INVALID_REF', 'Missing event address.', 'Use e:<seq>, e:<from>-<to>, or msg_id:<id>.');
    const cursor = typeof cursorRaw === 'string' && cursorRaw.trim() ? parseReadCursor(cursorRaw) : null;
    try {
        const result = service.readRaw(address, { maxItems: MAX_EVENT_ITEMS, maxChars, cursor });
        if (result.items.length === 0) {
            return errorText('NOT_FOUND', `No readable event at ${address}.`, result.note || 'The id may be cleaned up, hidden, or from another session.');
        }
        return formatEventReadResult(result, fmtDate);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorText(error instanceof RecallError ? error.code : 'READ_FAILED', message, 'Check the address format; use grep_raw if you only have a keyword.');
    }
}

/** 事件原始数据分支：SystemEvent.raw */
function resolveEventRaw(session: Session, parsed: ParsedContextRef, maxChars: number): string {
    const service = session.contextV2;
    if (!service) return errorText('LEGACY_SESSION', 'This session has no v2 context ledger.');
    const seq = parsed.eventSeq;
    if (!seq) return errorText('INVALID_REF', 'event_raw requires a seq.', 'Use kind=event_raw and ref=e:<seq>.');
    const store = service.getStore();
    const snapshot = service.snapshot();
    let found: ReturnType<typeof findEventBySeq>;
    try {
        found = findEventBySeq(store, snapshot, seq);
    } catch (error) {
        return errorText('READ_FAILED', error instanceof Error ? error.message : String(error));
    }
    if (!found.event) {
        const skipped = found.skippedPages.length ? ` skipped pages: ${found.skippedPages.join(',')}.` : '';
        return errorText('NOT_FOUND', `No event at e:${seq}.${skipped}`, 'The event may be cleaned up or outside the current session.');
    }
    const index = buildRecordIndex(snapshot.records);
    if (!isVisible(found.event, index)) {
        return errorText('HIDDEN', `Event e:${seq} is hidden by edit/redact/epoch records.`);
    }
    if (found.event.kind !== 'event') {
        return errorText('NOT_EVENT_RAW', `e:${seq} is a ${found.event.kind} event, not a system event.`, 'Use the event branch without kind=event_raw for normal messages.');
    }
    const event = found.event as { systemName?: string; eventType?: string; raw?: unknown; at?: number };
    if (event.raw === undefined) {
        return errorText('NO_RAW', `Event e:${seq} (${event.systemName || 'event'}) has no raw payload.`);
    }
    let json = '';
    try {
        json = JSON.stringify(event.raw, null, 2);
    } catch {
        return errorText('INVALID_RAW', `Event e:${seq} raw payload is not serializable.`);
    }
    const cut = truncate(json, maxChars);
    const header = resolveHeader('event_raw', {
        ref: `e:${seq}`,
        system: event.systemName,
        type: event.eventType,
        time: event.at ? fmtDate(Number(event.at)) : undefined,
        source: 'context',
    });
    return [
        header,
        cut.text,
        ...(cut.truncated ? [`[note] Truncated at ${maxChars} chars; the full raw JSON may be larger.`] : []),
        RESOLVE_EXTERNAL_NOTE,
    ].join('\n');
}

interface MemoryHit {
    kind: 'fact' | 'observation' | 'mental_model';
    bankId: string;
    text: string;
    fields: Record<string, string | number | undefined>;
}

function findMemory(session: Session, id: string, scope?: string, targetId?: string): MemoryHit | { error: string; code: 'FORBIDDEN' | 'NOT_FOUND'; hint?: string } {
    let banks: Array<{ bankId: string; kind: 'user' | 'group' | 'global' }>;
    if (targetId) {
        const resolved = resolveBank(session, scope, targetId);
        if (resolved.ok === false) return { error: resolved.error, code: 'FORBIDDEN' as const, hint: 'Only the owner can read another target memory.' };
        banks = [{ bankId: resolved.bankId, kind: resolved.kind }];
    } else if (scope === 'global') {
        // 全局记忆是只读注入内容，读取不要求骰主；写权限仍由 memory_* 工具控制
        banks = [{ bankId: MemoryService.globalBankId(session.agentName), kind: 'global' }];
    } else {
        banks = candidateMemoryBanks(session);
    }

    for (const bank of banks) {
        const fact = MemoryService.getFact(bank.bankId, id);
        if (fact) {
            return {
                kind: 'fact',
                bankId: bank.bankId,
                text: fact.text,
                fields: {
                    id: fact.id,
                    bank: fact.bankId,
                    state: fact.state,
                    importance: fact.importance,
                    created_at: fact.createdAt ? fmtDate(fact.createdAt) : undefined,
                    updated_at: fact.updatedAt ? fmtDate(fact.updatedAt) : undefined,
                    tags: (fact.tags || []).join(','),
                },
            };
        }
        const observation = MemoryService.getObservation(bank.bankId, id);
        if (observation) {
            return {
                kind: 'observation',
                bankId: bank.bankId,
                text: observation.text,
                fields: {
                    id: observation.id,
                    bank: observation.bankId,
                    status: observation.status,
                    proof_count: observation.proofCount,
                    created_at: observation.createdAt ? fmtDate(observation.createdAt) : undefined,
                    updated_at: observation.updatedAt ? fmtDate(observation.updatedAt) : undefined,
                    tags: (observation.tags || []).join(','),
                },
            };
        }
        const model = MemoryService.listMentalModels(bank.bankId).find(item => item.id === id);
        if (model) {
            return {
                kind: 'mental_model',
                bankId: bank.bankId,
                text: model.content || '(pending)',
                fields: {
                    id: model.id,
                    bank: model.bankId,
                    status: model.status,
                    query: model.sourceQuery,
                    updated_at: model.updatedAt ? fmtDate(model.updatedAt) : undefined,
                    tags: (model.tags || []).join(','),
                },
            };
        }
    }
    return {
        error: `Memory ${id} not found in the banks visible to this session.`,
        code: 'NOT_FOUND' as const,
        hint: 'If it is a personal/global memory, pass scope and target_id from the memory section heading.',
    };
}

function resolveMemory(session: Session, parsed: ParsedContextRef, maxChars: number, scope: string, targetId: string): string {
    const id = parsed.memoryId;
    if (!id) return errorText('INVALID_REF', 'Missing memory id.', 'Use [mem:<id>] or kind=memory with ref=<id>.');
    let hit: MemoryHit | { error: string; code: 'FORBIDDEN' | 'NOT_FOUND'; hint?: string };
    try {
        hit = findMemory(session, id, scope, targetId);
    } catch (error) {
        return errorText('MEMORY_UNAVAILABLE', error instanceof Error ? error.message : String(error), 'Memory may be disabled or not initialized.');
    }
    if ('error' in hit) return errorText(hit.code, hit.error, hit.hint);
    const cut = truncate(hit.text, maxChars);
    const header = formatMemoryRefHeader(hit.kind, { ...hit.fields, source: 'memory' });
    return [
        header,
        cut.text,
        ...(cut.truncated ? [`[note] Truncated at ${maxChars} chars; pass a larger max_chars or use memory_recall for a summary.`] : []),
        RESOLVE_EXTERNAL_NOTE,
    ].join('\n');
}

function formatSpecialData(kind: string, data: Record<string, unknown>): string {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        // base64 太大且对模型没有直接价值；需要协议字段时用 resolve_special_id
        if (key === 'base64') continue;
        safe[key] = value;
    }
    const header = formatMediaFields(kind, safe);
    return [header, RESOLVE_EXTERNAL_NOTE].join('\n');
}

/** 内容标签分支：img/avatar/record/video/file/quote/at/poke/forward/resource/face */
function resolveContentTag(session: Session, parsed: ParsedContextRef, maxChars: number): string {
    const part = parsed.part;
    if (!part) return errorText('UNSUPPORTED_REF', `Unsupported content tag: ${parsed.raw}`, 'Copy the whole tag, e.g. [img:...] or [record:...]summary[/record].');

    switch (part.type) {
        case 'image': {
            const ref = part.ref;
            if (/^data:/i.test(ref)) {
                return [
                    resolveHeader('image', { ref: 'data-uri', length: ref.length, description: part.desc, source: 'inline' }),
                    '[note] Inline data URI omitted (too large); use image_view/image_to_text if you need to inspect it.',
                    RESOLVE_EXTERNAL_NOTE,
                ].join('\n');
            }
            if (/^https?:/i.test(ref)) {
                const header = resolveHeader('image', { ref, description: part.desc, source: 'inline' });
                return [header, RESOLVE_EXTERNAL_NOTE].join('\n');
            }
            const out = resolveSpecialRef('image', ref);
            if (out.ok === false) return errorText(out.code, out.message, 'Image may be expired or not registered; use image_to_text for a description.');
            return formatSpecialData('image', { ...out.data, description: part.desc || out.data.description });
        }
        case 'avatar':
        case 'group_avatar': {
            const ref = part.type === 'avatar' ? `user_avatar:${part.uid}` : `group_avatar:${part.gid}`;
            const out = resolveSpecialRef('image', ref);
            if (out.ok === false) return errorText(out.code, out.message, `No cached avatar for ${ref}.`);
            return formatSpecialData('image', out.data);
        }
        case 'record':
        case 'video':
        case 'file': {
            const out = resolveSpecialRef(part.type, part.handle);
            if (out.ok === false) return errorText(out.code, out.message, 'Media handles are kept in memory only and expire after reload.');
            return formatSpecialData(part.type, out.data);
        }
        case 'quote': {
            const out = resolveSpecialRef('message', part.id);
            if (out.ok === false) return errorText(out.code, out.message, 'Copy the full [quote:<id>] tag or use msg_id:<id>.');
            const messageId = String(out.data.message_id ?? '');
            const lines = [resolveHeader('message', { ref: `[quote:${part.id}]`, message_id: messageId, source: 'context' })];
            const service = session.contextV2;
            if (service && out.id) {
                try {
                    const raw = service.readRaw(out.id, { maxItems: 1, maxChars });
                    if (raw.items.length > 0) lines.push(raw.items[0].text);
                } catch {
                    // 反查原文失败时仍返回 ID，不把解析整体判失败
                }
            }
            lines.push(RESOLVE_EXTERNAL_NOTE);
            return lines.join('\n');
        }
        case 'mention':
        case 'poke': {
            const rawId = String(part.id || '');
            const platform = getPlatform(session.sessionId);
            const uid = part.type === 'mention' && (part as { all?: true }).all ? 'all' : (normalizeUserId(rawId, platform) || rawId);
            const name = uid === 'all' ? '@all' : User.get(uid).userName;
            return [
                resolveHeader(part.type === 'mention' ? 'mention' : 'poke', { id: uid, name: name || undefined, source: 'roster' }),
                RESOLVE_EXTERNAL_NOTE,
            ].join('\n');
        }
        case 'forward': {
            return [
                resolveHeader('forward', { id: part.id, source: 'context' }),
                '[note] Merged-forward content is expanded when received; the original may no longer be fetchable. Use read_raw if a pointer exists.',
                RESOLVE_EXTERNAL_NOTE,
            ].join('\n');
        }
        case 'resource': {
            const fields: Record<string, string | number | undefined> = { uri: part.uri, name: part.name, mime: part.mime, source: 'context' };
            const mcp = /^mcp:\/\/([^/]+)\/(.*)$/i.exec(part.uri);
            if (mcp) {
                fields.server = mcp[1];
                fields.path = mcp[2];
            }
            return [resolveHeader('resource', fields), RESOLVE_EXTERNAL_NOTE].join('\n');
        }
        case 'face':
            return [resolveHeader('face', { name: part.name, source: 'context' }), RESOLVE_EXTERNAL_NOTE].join('\n');
        case 'markdown':
            return [resolveHeader('text', { format: 'markdown', source: 'context' }), part.text, RESOLVE_EXTERNAL_NOTE].join('\n');
        default:
            return errorText('UNSUPPORTED_TAG', `Tag [${part.type}] has no resolvable payload.`, 'Supported: img/avatar/record/video/file/quote/at/poke/forward/resource.');
    }
}

function dispatch(session: Session, parsed: ParsedContextRef, args: ResolveArgs, maxChars: number): string {
    const explicit = parsed.explicitKind;
    // 显式 kind 优先，但内容标签仍走标签分支
    const kind = parsed.part ? parsed.kind : (explicit && parsed.kind === 'unknown' ? explicit : parsed.kind);
    switch (kind) {
        case 'event':
            return resolveEvent(session, parsed, maxChars, args.cursor);
        case 'message':
            return parsed.part ? resolveContentTag(session, parsed, maxChars) : resolveEvent(session, parsed, maxChars, args.cursor);
        case 'image':
        case 'media':
        case 'resource':
        case 'forward':
        case 'face':
        case 'text':
            return resolveContentTag(session, parsed, maxChars);
        case 'memory':
            return resolveMemory(session, parsed, maxChars, stringArg(args.scope), stringArg(args.target_id));
        case 'event_raw':
            return resolveEventRaw(session, parsed, maxChars);
        default:
            return errorText(
                parsed.ambiguous ? 'AMBIGUOUS' : 'UNSUPPORTED_REF',
                parsed.ambiguous ? `Bare id ${parsed.raw} is ambiguous.` : `Cannot resolve ${parsed.raw || '(empty)'}.`,
                parsed.hint || 'Use e:<seq>, msg_id:<id>, [mem:<id>], a read_raw pointer, or a content tag.',
            );
    }
}

export function registerResolveContextRef() {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'resolve_context_ref',
            description: 'Resolve a compact reference copied from the context into concrete information (raw text, fields, metadata). ' +
                'Use it when the context shows a representation instead of the real thing: e:<seq>, e:<from>-<to>, msg_id:<id>, a read_raw pointer, ' +
                '[mem:<id>], [img:...], [avatar:...], [record:...]summary[/record], [video:...], [file:...], [quote:...], [at:...], [forward:...], or [resource:...]. ' +
                'Copy the tag/pointer verbatim; read-only; no network. For free-text search use grep_raw; for long known ranges use read_raw with paging.',
            parameters: {
                type: 'object',
                properties: {
                    ref: {
                        type: 'string',
                        description: 'Reference copied verbatim from the context (tag, pointer, e:<seq>, msg_id:<id>, [mem:<id>], etc.)',
                    },
                    kind: {
                        type: 'string',
                        enum: ['auto', 'event', 'message', 'image', 'media', 'memory', 'event_raw', 'resource', 'forward', 'face'],
                        description: 'Optional explicit type; auto detects from the tag/address. Use it when a bare id is ambiguous.',
                    },
                    max_chars: {
                        type: 'integer',
                        description: `Optional max characters returned, default ${DEFAULT_MAX_CHARS}, range ${MIN_MAX_CHARS}-${MAX_MAX_CHARS}`,
                    },
                    cursor: {
                        type: 'string',
                        description: 'Optional cursor from a previous event read; pass it back unchanged to continue',
                    },
                    scope: {
                        type: 'string',
                        enum: ['user', 'group', 'global'],
                        description: 'Optional memory bank scope when resolving a memory from a non-current bank',
                    },
                    target_id: {
                        type: 'string',
                        description: 'Optional memory bank target user/group id (owner-only for other targets)',
                    },
                },
                required: ['ref'],
            },
        },
    });
    tool.sessionType = 'any';
    tool.solve = async (_ctx, _msg, session, args) => {
        const a = (args || {}) as ResolveArgs;
        const raw = stringArg(a.ref);
        if (!raw) return errorText('INVALID_PARAMS', 'ref is required.', 'Copy the tag/pointer from the context.');
        const kindParam = stringArg(a.kind) || 'auto';
        const maxChars = intArg(a.max_chars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);
        const parsed = parseContextRef(raw, kindParam as ResolveKindParam);
        return dispatch(session, parsed, a, maxChars);
    };
}
