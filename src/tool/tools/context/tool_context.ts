// 上下文编辑工具：允许 AI 按序号定位并批量替换（纯文本字面量/正则）任意会话上下文中的正文文本。
// - 定位模型：复用 pub 目录的「botId/sid 路径 / 目录条目 ID 前缀」寻址（resolveSessionAddress），缺省=当前会话。
// - 范围：同一 SealDice 实例内可按 sessionId 定位（多端点/多账号/任意会话），凭 sessionId 惰性加载并写回本地存储；
//   跨会话写入要求目标会话**确实已存在**（存储里有存档），避免凭空生成会话记录。
// - 替换：只作用于正文 text 字段；存在原文副本（rawText 单条压缩 / rawItems 合并块 / tool rawText 截断）时同步双写，
//   保证持久化后 read_raw/grep_raw 读回内容与展示一致。
// - 安全：敏感工具（sensitive=true），默认开启；替换结果统一 stripUserTags 防标签注入。
import { renderText } from "../../../context/content/render";
import { ConversationEvent, Part } from "../../../context/events";
import Message from "../../../context/message";
import { editEventParts } from "../../../context/mutations";
import type { ContextService } from "../../../context/service";
import {
    AssistantMessage,
    MessageType,
    RawUserItem,
    ToolCallbackMessage,
    ToolCallsMessage,
    UserMessage,
    UserMessageItem,
} from "../../../context/types";
import { applyEdit, buildRecordIndex } from "../../../context/view/records";
import { getHost } from "../../../core/host";
import Logger from "../../../logger";
import { resolveSessionAddress } from "../../../pub/registry";
import { getSession } from "../../../session/session_service";
import { stripRawMarkers } from "../../../utils/raw_marker";
import { stripUserTags } from "../../../utils/string";
import Tool from "../../tool";

const log = Logger.withTag('context-edit');

/** 单次 list 返回条目默认/上限 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 摘要长度 */
const SUMMARY_CHARS = 80;

// ---------------- 定位 ----------------

function resolveTarget(
    session: { sessionId: string },
    botId?: unknown,
    sessionId?: unknown,
): { sid?: string; error?: string } {
    const bot = String(botId || '').trim();
    const sess = String(sessionId || '').trim();

    if (!bot && !sess) {
        return { sid: session.sessionId };
    }

    if (bot && sess) {
        const { match, reason } = resolveSessionAddress(`${bot}/${sess}`);
        if (!match) return { error: reason || `无法定位目标会话 ${bot}/${sess}` };
        return { sid: match.sid };
    }

    const addr = bot || sess;
    // 单字段：可能是完整路径（含 /）、目录条目 ID，或直接的 sessionId
    const { match } = resolveSessionAddress(addr);
    if (match) return { sid: match.sid };

    if (addr.includes(':') || addr.includes('Group')) {
        return { sid: addr };
    }
    return {
        error: `无法定位目标会话「${addr}」：请用 bot_id=<BotID> + session_id=<会话ID>，或传入完整 "BotID/会话ID" 路径`,
    };
}

/**
 * 会话是否真实存在（存储里有存档）。
 * getSession() 对任意未知 sessionId 都会**新建**一个 Session 并可由 save() 落盘，
 * 所以写入前必须先确认目标已存在，否则传一个不存在的群号/用户号就会在存储里凭空生成会话记录。
 * 当前会话（本轮对话的会话）一定存在，直接放行。
 */
function sessionExists(sid: string, currentSid: string): boolean {
    if (!sid) return false;
    if (sid === currentSid) return true;
    try {
        const raw = getHost().storage.get(`session_${sid}`);
        return !!raw && raw !== '{}';
    } catch (e) {
        log.warning(`检查会话 ${sid} 是否存在失败：${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

function labelOf(sid: string): string {
    return sid || '(当前会话)';
}

// ---------------- 摘要 ----------------

function flattenItemText(item: { text?: string }): string {
    if (!item || typeof item.text !== 'string') return '';
    return stripRawMarkers(item.text);
}

function messageSummary(m: MessageType): string {
    const type = Message.getMessageType(m);
    if (type === 'user') {
        const user = m as UserMessage;
        return (user.contentItems || []).map(flattenItemText).filter(Boolean).join(' / ');
    }
    if (type === 'assistant') {
        const am = m as AssistantMessage;
        return (am.contentItems || []).map(flattenItemText).filter(Boolean).join(' / ');
    }
    if (type === 'tool_calls') {
        const tcm = m as ToolCallsMessage;
        const names = (tcm.toolCalls || []).map(tc => tc.function && tc.function.name).filter(Boolean);
        return `[tool call] ${names.join(', ')}`;
    }
    if (type === 'tool_callback') {
        const tcb = m as ToolCallbackMessage;
        return `[tool result] ${tcb.toolName || 'unknown'}`;
    }
    return '';
}

function summarize(text: string, max = SUMMARY_CHARS): string {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

// ---------------- list ----------------

function messageRoleLabel(m: MessageType): string {
    const type = Message.getMessageType(m);
    switch (type) {
        case 'user': return 'user';
        case 'assistant': return 'assistant';
        case 'tool_calls': return 'assistant(tool_calls)';
        case 'tool_callback': return 'tool';
        default: return type;
    }
}

function messageTime(m: MessageType): number {
    const type = Message.getMessageType(m);
    if (type === 'user' || type === 'assistant') {
        const items = (m as UserMessage | AssistantMessage).contentItems;
        const first = items && items[0];
        if (first && typeof (first as any).time === 'number') return (first as any).time;
    }
    return 0;
}

/** 产出带稳定序号（数组下标）的条目表，支持 role / keyword / 时间过滤 */
function listEntries(
    msgs: MessageType[],
    filter: { role?: string; keyword?: string; timeFrom?: number; timeTo?: number },
): Array<{ idx: number; role: string; time: number; msgId: string; summary: string }> {
    const role = String(filter.role || '').toLowerCase().trim();
    const kw = String(filter.keyword || '').toLowerCase();

    const out: Array<{ idx: number; role: string; time: number; msgId: string; summary: string }> = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const roleLabel = messageRoleLabel(m);
        if (role && roleLabel !== role && !(role === 'assistant' && roleLabel === 'assistant(tool_calls)')) continue;

        const summary = messageSummary(m);
        if (kw && !summary.toLowerCase().includes(kw)) continue;

        const time = messageTime(m);
        if (filter.timeFrom !== undefined && time < filter.timeFrom) continue;
        if (filter.timeTo !== undefined && time > filter.timeTo) continue;

        let msgId = '';
        const type = Message.getMessageType(m);
        if (type === 'user') {
            const first = (m as UserMessage).contentItems?.[0] as UserMessageItem | undefined;
            if (first) msgId = first.messageId || '';
        } else if (type === 'assistant') {
            const first = (m as AssistantMessage).contentItems?.[0];
            if (first) msgId = first.messageId || '';
        }

        out.push({ idx: i, role: roleLabel, time, msgId, summary: summarize(summary) });
    }
    return out;
}

// ---------------- 替换核心 ----------------

/** 对单条 text 做替换。仅字面量/正则全局替换，不支持捕获组反向引用。返回结果、命中数与剩余配额。 */
function applyReplace(
    text: string,
    search: string,
    replacement: string,
    useRegex: boolean,
    countLeft: number,
): { resultText: string; hits: number; countLeft: number } {
    if (countLeft <= 0) return { resultText: text, hits: 0, countLeft };

    if (useRegex) {
        let regex: RegExp;
        try {
            regex = new RegExp(search, 'g');
        } catch (e) {
            throw new Error(`正则表达式无效: ${e instanceof Error ? e.message : String(e)}`);
        }
        let hits = 0;
        let left = countLeft;
        const resultText = text.replace(regex, () => {
            if (left <= 0) return ''; // 防御：配额耗尽后本不该再进，安全兜底
            left--;
            hits++;
            return replacement;
        });
        return { resultText, hits, countLeft: left };
    }

    if (search === '') return { resultText: text, hits: 0, countLeft };
    let resultText = text;
    let hits = 0;
    let from = 0;
    let left = countLeft;
    while (left > 0) {
        const pos = resultText.indexOf(search, from);
        if (pos < 0) break;
        resultText = resultText.slice(0, pos) + replacement + resultText.slice(pos + search.length);
        from = pos + replacement.length;
        hits++;
        left--;
    }
    return { resultText, hits, countLeft: left };
}

/**
 * 对单条可编辑文本执行替换并同步副本（rawText / rawItems / tool rawText）。
 * 返回本次命中数与剩余配额。副本替换不受 count 限制（跟随正文全量替换，保证一致性）。
 */
function replaceInText(
    owned: { text?: string; rawText?: string; rawItems?: RawUserItem[] },
    search: string,
    replacement: string,
    useRegex: boolean,
    countLeft: number,
): { hits: number; countLeft: number } {
    if (typeof owned.text !== 'string') return { hits: 0, countLeft };
    if (owned.text.length === 0 && search !== '') return { hits: 0, countLeft };

    const main = applyReplace(owned.text, search, replacement, useRegex, countLeft);
    const hits = main.hits;
    if (hits === 0) return { hits: 0, countLeft };

    owned.text = main.resultText;

    if (typeof owned.rawText === 'string') {
        const raw = applyReplace(owned.rawText, search, replacement, useRegex, Number.MAX_SAFE_INTEGER);
        owned.rawText = raw.resultText;
    }
    if (Array.isArray(owned.rawItems)) {
        for (const item of owned.rawItems) {
            if (item && typeof item.text === 'string') {
                const r = applyReplace(item.text, search, replacement, useRegex, Number.MAX_SAFE_INTEGER);
                item.text = r.resultText;
            }
        }
    }

    return { hits, countLeft: main.countLeft };
}

/**
 * 解析 scope 为命中的消息下标集合。
 * 返回 error 表示 scope 本身无法解析（区别于"解析成功但没有命中"）：
 * 旧实现把非法/越界的 idx 一律退化成空数组，外部统一报"未命中"，
 * 会让 AI 误判成文本没匹配上；越界范围还会被静默钳制成**全量**（idx:0-99 → 全部消息）。
 */
function resolveScopeIndices(msgs: MessageType[], scope: string): { indices: number[]; error?: string; note?: string } {
    const s = String(scope || '').trim().toLowerCase();
    const total = msgs.length;

    if (s === '' || s === 'all') {
        const arr: number[] = [];
        for (let i = 0; i < total; i++) arr.push(i);
        return { indices: arr };
    }

    if (s.startsWith('role:')) {
        const role = s.slice(5).trim();
        const arr: number[] = [];
        for (let i = 0; i < total; i++) {
            const label = messageRoleLabel(msgs[i]);
            if (label === role || (role === 'assistant' && label === 'assistant(tool_calls)')) {
                arr.push(i);
            }
        }
        return { indices: arr };
    }

    if (s.startsWith('idx:')) {
        const spec = scope.trim().slice(4).trim();
        const range = spec.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!range) {
            return { indices: [], error: `scope 的 idx 写法非法：「${spec}」。可用 idx:<n> 或 idx:<a>-<b>（序号为非负整数，先用 context_edit_list 查看）` };
        }
        const a = parseInt(range[1], 10);
        const b = range[2] !== undefined ? parseInt(range[2], 10) : a;
        const lo = Math.max(0, Math.min(a, b));
        const hi = Math.min(total - 1, Math.max(a, b));
        if (hi < lo) {
            return { indices: [], error: `scope 的 idx 越界：请求 ${spec}，但当前会话只有 ${total} 条（序号 0~${Math.max(0, total - 1)}）` };
        }
        const arr: number[] = [];
        for (let i = lo; i <= hi; i++) arr.push(i);
        const clamped = (Math.min(a, b) < lo) || (Math.max(a, b) > hi);
        return {
            indices: arr,
            note: clamped ? `（idx 越界已收敛为实际范围 ${lo}-${hi}，共 ${arr.length} 条）` : undefined,
        };
    }

    return { indices: [], error: `无法解析的 scope：「${scope}」。可用 all / role:<role> / idx:<n> / idx:<a>-<b>` };
}

/** 遍历 messages 按 scope 落点执行替换。scope 为 'all' 时遍历全部；'role:x' / 'idx:n' / 'idx:a-b' 时按过滤结果 */
function replaceInMessages(
    msgs: MessageType[],
    scope: string,
    search: string,
    replacement: string,
    useRegex: boolean,
    count: number,
): { entries: number; hits: number; countLeft: number; error?: string; note?: string } {
    const resolved = resolveScopeIndices(msgs, scope);
    // scope 本身无法解析/越界：原样上抛，让调用方与"没命中"区分开
    if (resolved.error) return { entries: 0, hits: 0, countLeft: count, error: resolved.error };
    const indices = resolved.indices;
    let countLeft = count;
    let entries = 0;
    let hits = 0;

    for (const i of indices) {
        const m = msgs[i];
        const type = Message.getMessageType(m);

        if (type === 'user') {
            const user = m as UserMessage;
            for (const item of (user.contentItems || [])) {
                const r = replaceInText(item as any, search, replacement, useRegex, countLeft);
                if (r.hits === 0) continue;
                hits += r.hits;
                countLeft = r.countLeft;
                entries++;
            }
        } else if (type === 'assistant') {
            const am = m as AssistantMessage;
            for (const item of (am.contentItems || [])) {
                const r = replaceInText(item as any, search, replacement, useRegex, countLeft);
                if (r.hits === 0) continue;
                hits += r.hits;
                countLeft = r.countLeft;
                entries++;
            }
        } else if (type === 'tool_callback') {
            const tcb = m as ToolCallbackMessage;
            const r = replaceInText(tcb as any, search, replacement, useRegex, countLeft);
            if (r.hits > 0) {
                hits += r.hits;
                countLeft = r.countLeft;
                entries++;
            }
        }
        // tool_calls 消息（结构化 toolCalls）不参与正文替换

        if (countLeft <= 0) break;
    }

    return { entries, hits, countLeft, note: resolved.note };
}

// ---------------- 防注入 ----------------

/**
 * 替换文本的防注入清洗。
 * 必须用 stripUserTags：它会把可发送/媒体单行标签（[at:…]/[img:…]/[record:…] 等）转义为字面量，
 * 并整段删除伪造的闭合标签。若用 stripInternalTags，这些标签会被**原样保留**，
 * 而本函数的产物会被写进上下文并持久化 —— 后续经回复管线渲染即成为真实发送指令
 * （等价于让被污染的上下文获得「@全体成员 / 发外链图」的能力，且反复生效）。
 */
function sanitizeText(text: string): string {
    return stripUserTags(text);
}

// ---------------- 工具注册 ----------------

function normalizeArgs(args: any): Record<string, unknown> {
    return (args && typeof args === 'object') ? args : {};
}

// ---------------- Context v2 编辑（按 seq 定位） ----------------

function v2Role(event: ConversationEvent): 'user' | 'assistant' | 'tool' {
    if (event.kind === 'user') return 'user';
    if (event.kind === 'assistant') return 'assistant';
    if (event.kind === 'tool_call' || event.kind === 'tool_result') return 'tool';
    return 'assistant';
}

function v2Text(event: ConversationEvent, parts?: Part[]): string {
    const p = parts ?? ((event as { parts?: Part[] }).parts ?? []);
    if (event.kind === 'tool_call') {
        const e = event as { name?: string; args?: string };
        return `[tool_call:${e.name ?? ''}] ${e.args ?? ''}`.trim();
    }
    return renderText(p);
}

interface V2ReplaceResult {
    entries: number;
    hits: number;
    error?: string;
}

function replaceInV2(
    service: ContextService,
    scope: string,
    search: string,
    replacement: string,
    useRegex: boolean,
    maxCount: number,
): V2ReplaceResult {
    const store = service.getStore();
    const snapshot = store.snapshot();
    const index = buildRecordIndex(snapshot.records);
    let predicate: ((event: ConversationEvent) => boolean) | null = null;
    const roleMatch = /^role:(\w+)$/.exec(scope);
    const idxMatch = /^idx:(\d+)(?:-(\d+))?$/.exec(scope);
    if (scope === 'all') predicate = () => true;
    else if (roleMatch) {
        const role = roleMatch[1].toLowerCase();
        predicate = event => v2Role(event) === role;
    } else if (idxMatch) {
        const from = Number(idxMatch[1]);
        const to = idxMatch[2] ? Number(idxMatch[2]) : from;
        predicate = event => event.seq >= from && event.seq <= to;
    } else {
        return { entries: 0, hits: 0, error: `scope 非法：${scope}。支持 all / role:<role> / idx:<seq> / idx:<a>-<b>` };
    }

    let remaining = maxCount;
    let entries = 0;
    let hits = 0;
    for (const event of snapshot.events) {
        if (remaining <= 0) break;
        if (!predicate(event)) continue;
        const parts = applyEdit(event, index);
        let changed = false;
        const next: Part[] = parts.map(part => {
            if (part.type !== 'text' || remaining <= 0) return { ...part };
            let text = part.text;
            if (useRegex) {
                const re = new RegExp(search, 'g');
                text = text.replace(re, () => {
                    if (remaining <= 0) return search;
                    remaining--;
                    hits++;
                    return replacement;
                });
            } else {
                while (remaining > 0) {
                    const at = text.indexOf(search);
                    if (at < 0) break;
                    text = text.slice(0, at) + replacement + text.slice(at + search.length);
                    remaining--;
                    hits++;
                }
            }
            if (text !== part.text) changed = true;
            return changed ? { type: 'text', text } : { ...part };
        });
        if (changed) {
            editEventParts(store, event.seq, next);
            entries++;
        }
    }
    return { entries, hits };
}

export function registerContextEditTools() {
    // ===== context_edit_list =====
    const listTool = new Tool({
        type: 'function',
        function: {
            name: 'context_edit_list',
            description:
                'List the structured entries of a session context (with stable sequence numbers idx) for precise targeting by context_edit_replace. ' +
                'Read-only; changes nothing.\n' +
                'Target session: defaults to the current session; for cross-session use bot_id + session_id (BotID such as QQ:123, session ID such as QQ-Group:456 or QQ:789); bot_id or session_id alone is also accepted (a full "BotID/sessionID" path also works).\n' +
                'Optional filters: role (user/assistant/tool), keyword, time_from/time_to. idx is the message index in the context array and is stable only within the short lifetime of "list then immediately replace in the same turn".',
            parameters: {
                type: 'object',
                properties: {
                    bot_id: { type: 'string', description: 'Optional: target bot endpoint ID (with platform prefix, e.g. QQ:123456)' },
                    session_id: { type: 'string', description: 'Optional: target session ID (e.g. QQ-Group:7890 or QQ:111)' },
                    role: { type: 'string', description: 'Optional: user / assistant / tool (tool_calls count as assistant(tool_calls))' },
                    keyword: { type: 'string', description: 'Optional: substring filter on the body text (case-insensitive)' },
                    time_from: { type: 'integer', description: 'Optional: start time (Unix seconds)' },
                    time_to: { type: 'integer', description: 'Optional: end time (Unix seconds)' },
                    limit: { type: 'integer', description: `Optional: max entries to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
                },
                required: [],
            },
        },
    });
    listTool.sessionType = 'any';
    listTool.solve = async (_ctx, _msg, session, args) => {
        const a = normalizeArgs(args);
        const { sid, error } = resolveTarget(session, a.bot_id, a.session_id);
        if (error) return error;

        let target: any;
        try {
            target = getSession(sid as string);
        } catch (e) {
            return `加载目标会话失败: ${e instanceof Error ? e.message : String(e)}`;
        }

        const limit = Math.min(Math.max(parseInt(String(a.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const timeFrom = a.time_from !== undefined && a.time_from !== null ? Number(a.time_from) : undefined;
        const timeTo = a.time_to !== undefined && a.time_to !== null ? Number(a.time_to) : undefined;

        if (target?.contextV2) {
            const events = target.contextV2.snapshot().events.filter((event: ConversationEvent) => {
                if (a.role && v2Role(event) !== String(a.role).toLowerCase()) return false;
                if (a.keyword && !v2Text(event).toLowerCase().includes(String(a.keyword).toLowerCase())) return false;
                if (timeFrom !== undefined && event.at < timeFrom) return false;
                if (timeTo !== undefined && event.at > timeTo) return false;
                return true;
            });
            const header = `【上下文条目 · ${labelOf(sid as string)}】共 ${target.contextV2.snapshot().events.length} 条事件，命中 ${events.length} 条（seq 供 context_edit_replace 定位）`;
            if (events.length === 0) return `${header}\n（无命中条目：可放宽 role/keyword/时间过滤）`;
            const lines = events.slice(0, limit).map(event => {
                const msgId = (event as { msgId?: string }).msgId;
                return `[seq=${event.seq}] role=${v2Role(event)} | time=${event.at || '-'}${msgId ? ` | msg_id=${msgId}` : ''} | ${v2Text(event).slice(0, 120)}`;
            });
            if (events.length > limit) lines.push(`…（另有 ${events.length - limit} 条未展示，缩小过滤范围后再查）`);
            return `${header}\n${lines.join('\n')}`;
        }

        const msgs: MessageType[] = (target && target.context && Array.isArray(target.context.messages)) ? target.context.messages : [];

        const entries = listEntries(msgs, {
            role: a.role as string | undefined,
            keyword: a.keyword as string | undefined,
            timeFrom,
            timeTo,
        });

        const header = `【上下文条目 · ${labelOf(sid as string)}】共 ${msgs.length} 条消息，命中 ${entries.length} 条（以下最多展示 ${limit} 条，序号 idx 供 context_edit_replace 定位）`;
        if (entries.length === 0) {
            return `${header}\n（无命中条目：可放宽 role/keyword/时间过滤，或确认目标会话路径正确）`;
        }
        const shown = entries.slice(0, limit);
        const lines = shown.map(e =>
            `[idx=${e.idx}] role=${e.role} | time=${e.time || '-'}${e.msgId ? ` | msg_id=${e.msgId}` : ''} | ${e.summary}`,
        );
        if (entries.length > limit) {
            lines.push(`…（另有 ${entries.length - limit} 条未展示，缩小过滤范围后再查）`);
        }
        return `${header}\n${lines.join('\n')}`;
    };

    // ===== context_edit_replace =====
    const replaceTool = new Tool({
        type: 'function',
        function: {
            name: 'context_edit_replace',
            description:
                'Batch-replace (plain-text literal or regex) the body text of a target session context; an empty replacement deletes the matched text. Raw copies are updated in sync and persisted. ' +
                'This is a sensitive operation that modifies the AI own/others memory and cannot be rolled back automatically.\n' +
                'Always locate the exact sequence numbers/range with context_edit_list first, then narrow it precisely with scope to avoid unintended edits.\n' +
                'Target session: defaults to the current session; for cross-session use bot_id + session_id (same as context_edit_list).\n' +
                'scope: all (default, everything) / role:<role> / idx:<n> / idx:<a>-<b>. Only the body text field is replaced; compressed/truncated raw copies (rawText/rawItems) are updated in sync.',
            parameters: {
                type: 'object',
                properties: {
                    bot_id: { type: 'string', description: 'Optional: target bot endpoint ID (with platform prefix, e.g. QQ:123456)' },
                    session_id: { type: 'string', description: 'Optional: target session ID (e.g. QQ-Group:7890 or QQ:111)' },
                    scope: { type: 'string', description: 'Optional: replacement scope: all / role:<role> / idx:<n> / idx:<a>-<b>, default all' },
                    search: { type: 'string', description: 'Required: plain-text literal to match (or a regex source, see match)' },
                    replacement: { type: 'string', description: 'Required: replacement text (empty string deletes the matched text)' },
                    match: { type: 'string', description: 'Optional: literal (default, substring replacement) / regex (global, capture-group backreferences not supported)' },
                    count: { type: 'integer', description: 'Optional: max replacements; omit to replace all matches' },
                },
                required: ['search', 'replacement'],
            },
        },
    });
    replaceTool.sensitive = true;
    replaceTool.sessionType = 'any';
    replaceTool.solve = async (_ctx, _msg, session, args) => {
        const a = normalizeArgs(args);
        const search = String(a.search ?? '');
        if (search === '') return 'search 不能为空：请提供要匹配的文本（用空 replacement 表示删除，而非空 search）';
        const replacement = sanitizeText(String(a.replacement ?? ''));
        const useRegex = String(a.match || 'literal').toLowerCase() === 'regex';
        const scope = String(a.scope || 'all');
        // count：仅"未提供"时才不限量。显式给了就必须是 >=1 的整数 ——
        // 旧实现用 `parseInt(...) || 0` 把 count=0/-5/"abc" 一律变成 0，
        // 之后被 applyReplace 的 countLeft<=0 短路，最终误报成"范围内未命中"，
        // 会让 AI 误以为文本没匹配上而放宽 scope 甚至改成 scope=all 重试。
        const countProvided = a.count !== undefined && a.count !== null && String(a.count).trim() !== '';
        let count = Number.MAX_SAFE_INTEGER;
        if (countProvided) {
            const parsed = Number(String(a.count).trim());
            if (!Number.isInteger(parsed) || parsed < 1) {
                return `count 参数非法：${JSON.stringify(a.count)}。请传 >=1 的整数（表示最多替换多少处），或省略该参数表示不限量。`;
            }
            count = parsed;
        }
        const countIsLimited = countProvided;

        const { sid, error } = resolveTarget(session, a.bot_id, a.session_id);
        if (error) return error;

        // 跨会话写入前必须确认目标会话已存在：getSession() 会为未知 sid 新建会话，
        // 直接写入会在存储里凭空生成一条会话记录。
        if (!sessionExists(sid as string, session.sessionId)) {
            return `目标会话 ${labelOf(sid as string)} 不存在（存储中没有该会话存档），已拒绝写入以免凭空创建会话；请先用 context_edit_list 确认会话 ID。`;
        }

        let target: any;
        try {
            target = getSession(sid as string);
        } catch (e) {
            return `加载目标会话失败: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (target?.contextV2) {
            let outcome: V2ReplaceResult;
            try {
                outcome = replaceInV2(target.contextV2, scope, search, replacement, useRegex, count);
            } catch (e) {
                log.warning(`上下文替换执行失败: ${e instanceof Error ? e.message : String(e)}`);
                return `替换失败：${e instanceof Error ? e.message : String(e)}`;
            }
            if (outcome.error) return outcome.error;
            if (outcome.entries === 0 && outcome.hits === 0) {
                return `目标会话 ${labelOf(sid as string)} 范围内未命中「${search}」：请先 context_edit_list 核对 seq 与实际文本。`;
            }
            const flushed = await target.contextV2.flush();
            if (!flushed.ok) return `替换已在内存生效但落盘失败: ${flushed.error ?? 'unknown'}（请重试）`;
            log.info(`上下文替换(v2): target=${labelOf(sid as string)} scope=${scope} 改动${outcome.entries}条 命中${outcome.hits}处`);
            return [
                `已完成上下文替换 · ${labelOf(sid as string)}`,
                `scope=${scope} | match=${useRegex ? 'regex' : 'literal'} | ${replacement === '' ? '[删除]' : '替换'} | 改动事件 ${outcome.entries} 条 | 共替换 ${outcome.hits} 处`,
            ].join('\n');
        }

        const msgs: MessageType[] = (target && target.context && Array.isArray(target.context.messages)) ? target.context.messages : [];

        if (msgs.length === 0) {
            return `目标会话 ${labelOf(sid as string)} 没有可编辑的上下文内容。`;
        }

        let outcome: ReturnType<typeof replaceInMessages>;
        try {
            outcome = replaceInMessages(msgs, scope, search, replacement, useRegex, count);
        } catch (e) {
            log.warning(`上下文替换正则执行失败: ${e instanceof Error ? e.message : String(e)}`);
            return `替换失败（正则或匹配过程出错）：${e instanceof Error ? e.message : String(e)}`;
        }

        // scope 无法解析：报"scope 有问题"，不要和"文本没匹配上"混为一谈
        if (outcome.error) return outcome.error;

        if (outcome.entries === 0 && outcome.hits === 0) {
            return `目标会话 ${labelOf(sid as string)} 范围内未命中「${search}」：请先 context_edit_list 核对 scope 与实际文本。`;
        }

        // 持久化
        try {
            if (typeof target.save === 'function') {
                target.save();
            }
        } catch (e) {
            return `替换已在内存生效但持久化失败: ${e instanceof Error ? e.message : String(e)}（请重试或检查存储）`;
        }

        log.info(`上下文替换: target=${labelOf(sid as string)} scope=${scope} 改动${outcome.entries}条 命中${outcome.hits}处`);

        const deleted = replacement === '';
        const parts: string[] = [
            `已完成上下文替换 · ${labelOf(sid as string)}`,
            `scope=${scope} | match=${useRegex ? 'regex' : 'literal'} | ${deleted ? '[删除]' : '替换'} | 改动消息 ${outcome.entries} 条 | 共替换 ${outcome.hits} 处`,
        ];
        if (outcome.note) parts.push(`注意：${outcome.note}`);
        if (countIsLimited && outcome.countLeft === 0) {
            parts.push(`已用尽替换配额（count 限制），如有更多命中未处理，可提高 count 再次执行。`);
        }
        return parts.join('\n');
    };
}
