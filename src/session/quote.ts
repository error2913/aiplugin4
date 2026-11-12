// 引用回复展开（收信层）：把 reply 段指向的「被引原始消息」解析成冻结快照 QuoteDraft。
// 本文件只做"取数据 + 冻结"，不含任何渲染——`[from:…][quote_of:…]` 由 context/view/compile 负责。
//
// 解析顺序（REQ-D6-01/02/03）：
//   c1. 上下文事件账本按 msg_id 查（本地、最快、不产生网络调用）；
//   c2. 账本没有 ⇒ ob11 `get_msg`（带 3s 硬超时，失败/超时/无网络都返回 null）；
//   c3. 都失败 ⇒ 返回 null，由调用方写 `[quote_unavailable:<id>]` 占位正文（不抛错、不阻塞收信）。
//
// 约束：任何异常都在本文件内被吞掉（引用展开是增强功能，绝不能让消息丢失）；同 msgId 30s 内不重复拉取，
// 失败同样缓存（避免连续引用同一条时反复打协议端，REQ-D6-12）。
import { parseText } from "../context/content/text_parse";
import type { Part, QuoteDraft } from "../context/events";
import type { ContextService } from "../context/service";
import { logger } from "../logger";
import { callOb11ApiForContext } from "../transport/ob11/dispatcher";
import { normalizeMsgId, transformMsgIdBack } from "../utils/message_id";
import { type MessageSegment, transformArrayToContent, transformTextToArray } from "../utils/string";
import { normalizeUserId, platformOf } from "../utils/target_id";
import { withDeadline } from "../utils/timeout";

import type { Session } from "./session";
import User from "./user";

const log = logger.withTag('quote');

export type { QuoteDraft } from "../context/events";

/** 同 msgId 30s 内不重复拉取（REQ-D6-12）；失败也缓存（value=null） */
export const QUOTE_CACHE_TTL_MS = 30_000;

/** ob11 `get_msg` 超时（REQ-D6-12）；导出便于单测把超时缩短到几十毫秒 */
export const OB11_TIMEOUT_MS = 3_000;

/**
 * 单测注入的超时（默认 null = 用 OB11_TIMEOUT_MS）。
 * 生产不调用；只暴露这一层是因为 `OB11_TIMEOUT_MS` 是 const 绑定，测试无法改写。
 */
let ob11TimeoutOverride: number | null = null;

/** 仅测试用：缩短 `get_msg` 超时（传 null 还原默认） */
export function setQuoteOb11TimeoutForTest(ms: number | null): void {
    ob11TimeoutOverride = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : null;
}

/** 缓存条目上限：超限按插入序淘汰最早一条，防长跑泄漏（Goja 无 WeakRef，用 Map + 时间戳） */
const QUOTE_CACHE_MAX = 256;

interface QuoteCacheEntry {
    at: number;
    /** null = 展开失败（同样缓存，失败不重试，REQ-D6-12） */
    value: QuoteDraft | null;
}

/** 模块级缓存：key 为 `${endPoint.userId}|${quoteId}`，避免不同机器人/端点同 msgId 撞车 */
const quoteCache = new Map<string, QuoteCacheEntry>();

/** 仅测试用：清空模块级缓存（模块单例，跨用例必须显式重置，否则 T15-5 之类的计数断言会被前序用例污染） */
export function resetQuoteCacheForTest(): void {
    quoteCache.clear();
}

/**
 * 从入站消息段里取出被引消息的 base36 短 id（REQ-D6-10）。
 * reply 段缺失、id 为空或非法时返回 ''（调用方据此完全跳过展开，行为与改造前一致，T15-10）。
 * 归一口径与 `transformArrayToContent` 的 `[quote:<base36>]` 一致：十进制 → base36，已是短 id 保持原样；
 * 再要求结果只含 base36 字符，避免把非消息 ID 的垃圾串当成被引消息去展开（内容侧同样会丢弃它）。
 */
export function extractQuoteId(messageArray: MessageSegment[]): string {
    if (!Array.isArray(messageArray)) return '';
    for (const seg of messageArray) {
        if (!seg || seg.type !== 'reply') continue;
        const raw = seg.data ? seg.data.id : '';
        const id = normalizeMsgId(raw);
        if (id && /^[+-]?[0-9a-z]+$/i.test(id)) return id;
    }
    return '';
}

/**
 * 展开一条被引消息（REQ-D6-01/02/03/12）；返回冻结快照或 null（null ⇒ 调用方写占位）。
 * 全程不抛错：网络异常、超时、解析失败、账本缺失都只降级为 null。
 */
export async function resolveQuote(
    session: Session,
    ctx: seal.MsgContext,
    msg: seal.Message,
    quoteId: string,
): Promise<QuoteDraft | null> {
    const id = String(quoteId ?? '').trim();
    if (!id) return null;
    // v1（旧 messages 模型）没有事件账本，也就没有"引用事件"的概念：不展开，行为与改造前完全一致
    const service = session.contextV2;
    if (!service) return null;

    const key = `${ctx.endPoint ? ctx.endPoint.userId : ''}|${id}`;
    const now = Date.now();
    const cached = quoteCache.get(key);
    if (cached && now - cached.at < QUOTE_CACHE_TTL_MS) return cached.value;

    let value: QuoteDraft | null = null;
    let fromContext = false;
    try {
        value = resolveFromContext(service, ctx, id);
        fromContext = value !== null;
        // c2：账本没有才走网络（c1 命中时不产生任何协议调用，T15-1）
        if (!value) value = await fetchQuoteFromOb11(ctx, msg, id);
    } catch (e) {
        // 超时/网络/解析异常统一降级：写占位即可，绝不向上抛（REQ-D6-03）
        log.warning(`引用消息 ${id} 展开失败（写占位）：${e instanceof Error ? e.message : String(e)}`);
        value = null;
    }

    // 只缓存"账本未命中"的结论（含失败）：账本命中本身已是最快路径，缓存它没有收益
    if (!fromContext) {
        quoteCache.set(key, { at: now, value });
        if (quoteCache.size > QUOTE_CACHE_MAX) {
            const oldest = quoteCache.keys().next();
            if (!oldest.done) quoteCache.delete(oldest.value);
        }
    }
    return value;
}

/**
 * c1：上下文事件账本查找（REQ-D6-01）。
 * - user 事件（含 origin:'quote'）⇒ 用事件里冻结的 uid/fromName/parts；
 * - assistant 事件（引用机器人自己的话，T15-11）⇒ 发言人是当前端点；
 * - tool_call/tool_result/event 不是"用户消息"，不作为引用展开对象。
 */
function resolveFromContext(service: ContextService, ctx: seal.MsgContext, quoteId: string): QuoteDraft | null {
    const event = service.findEventByMsgId(quoteId);
    if (!event) return null;
    if (event.kind === 'user') {
        const parts = cloneParts(event.parts);
        if (parts.length === 0) return null;
        const uid = String(event.uid || '') || 'unknown';
        return { msgId: quoteId, uid, fromName: pickDisplayName(String(event.fromName || ''), uid), parts };
    }
    if (event.kind === 'assistant') {
        const parts = cloneParts(event.parts);
        if (parts.length === 0) return null;
        const uid = ctx.endPoint && ctx.endPoint.userId ? String(ctx.endPoint.userId) : 'unknown';
        return { msgId: quoteId, uid, fromName: pickDisplayName('', uid), parts };
    }
    return null;
}

/**
 * c2：ob11 `get_msg`（REQ-D6-02）。
 * 显式把 base36 短 id 还原成原始十进制 id（不依赖 dispatcher 的启发式还原）；
 * 只认 `ok === true` 的结果，其余（无网络依赖/协议端报错/超时）一律 null。
 */
async function fetchQuoteFromOb11(ctx: seal.MsgContext, msg: seal.Message, quoteId: string): Promise<QuoteDraft | null> {
    const rawId = transformMsgIdBack(quoteId);
    if (rawId === '') return null;
    const result = await withDeadline(
        () => callOb11ApiForContext(ctx, msg, 'get_msg', { message_id: rawId }),
        ob11TimeoutOverride ?? OB11_TIMEOUT_MS,
    );
    if (!result || result.ok !== true || !result.data) return null;
    const data = result.data as {
        raw_message?: string;
        message?: unknown;
        sender?: { user_id?: string | number; card?: string; nickname?: string };
    };
    // 优先 raw_message 字符串（CQ 码形态最稳）；退而用 message 数组（部分协议端只返回数组）
    const segments: MessageSegment[] = typeof data.raw_message === 'string' && data.raw_message
        ? transformTextToArray(data.raw_message)
        : (Array.isArray(data.message) ? (data.message as MessageSegment[]) : []);
    if (segments.length === 0) return null;
    // 与入站正文同一条转换路径：图片段仍走 handleImageMessageSegment（RECEIVE_IMAGE 关闭时无 image part，
    // 与现网入站策略一致），文本段仍做防注入剥离（REQ-D6-04：parts 为原始完整 parts）
    const { content } = await transformArrayToContent(ctx, segments, quoteId);
    const parts = parseText(content, 'model-output');
    if (parts.length === 0) return null;
    const sender = data.sender || {};
    const uid = normalizeUserId(sender.user_id ?? '', platformOf(ctx)) || 'unknown';
    const hinted = String(sender.card || '').trim() || String(sender.nickname || '').trim();
    return { msgId: quoteId, uid, fromName: pickDisplayName(hinted, uid), parts };
}

/** 显示名优先级：消息自带的卡片/昵称 → 已记录的用户名 → uid 本身（与原 `[from:…]` 口径一致） */
function pickDisplayName(hint: string, uid: string): string {
    const name = String(hint || '').trim();
    if (name) return name;
    let stored = '';
    try {
        stored = String(User.get(uid).userName || '').trim();
    } catch (_e) {
        // 用户存储不可用时只用 uid，不影响展开
        stored = '';
    }
    return stored || uid || 'unknown';
}

/** 拷贝 parts：引用事件与回复事件不能共享同一数组引用（后续 edit/序列化会互相影响，REQ-D6-04 风险①） */
function cloneParts(parts: Part[]): Part[] {
    if (!Array.isArray(parts)) return [];
    try {
        return JSON.parse(JSON.stringify(parts)) as Part[];
    } catch (_e) {
        return parts.slice();
    }
}

/** 供上层判断事件是否已展开（把 `q:<msgId>` 约定收在一处，避免多处手拼字符串写错前缀） */
export function quoteEventId(quoteId: string): string {
    return `q:${quoteId}`;
}
