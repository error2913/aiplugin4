// 平台消息段（milky/ob11 形态 + CQ）→ Part[]。
// 纯逻辑：图片/语音/文件等实体登记通过注入回调完成（不 import seal / Image），
// 未注入回调时退化为引用字符串或 unknown —— 内容永不静默丢失。
import type { Part } from "../events";

import { ParseMode } from "./descriptors";
import { parseText } from "./text_parse";

/** 结构化消息段的最小形状（与 utils/string 的 MessageSegment 结构兼容） */
export interface PlatformSegmentInput {
    type: string;
    data?: Record<string, unknown>;
}

/** 入站媒体登记结果（图片走 CIR ref；语音/视频/文件走句柄） */
export interface InboundImageResult {
    /** CIR 引用：插件图片 ID / h<sha> / 头像别名 / URL */
    ref: string;
    /** 图片描述（会进入规范文本标签 [img:ref:desc]） */
    desc?: string;
}

export interface InboundMediaResult {
    /** 资源句柄（special id / local resource id） */
    handle: string;
    summary?: string;
}

/** 入站解析注入点：所有依赖宿主（平台 ID 规范化、媒体实体、静态表）的能力都从这里注入 */
export interface SegmentParseContext {
    /** 用户 id 规范化（如 QQ:123）；返回 null 时退回原始字符串 */
    uid?(raw: unknown): string | null | undefined;
    /** 群 id 规范化 */
    groupId?(raw: unknown): string | null | undefined;
    /** 消息 id 规范化（reply/quote 用 base36 短 id） */
    quoteId?(raw: unknown): string | null | undefined;
    /** 合并转发 id 规范化（无法展开时返回 null，调用方按 unknown 保留） */
    forwardId?(raw: unknown): string | null | undefined;
    /** 表情 id → 表情名（静态表） */
    faceName?(id: string): string | null | undefined;
    /** 图片段 → CIR 引用（接收时登记 Image 实体） */
    image?(segment: PlatformSegmentInput, index: number): InboundImageResult | null | undefined;
    /** 语音/视频/文件段 → 资源句柄 */
    media?(segment: PlatformSegmentInput, kind: 'record' | 'video' | 'file', index: number): InboundMediaResult | null | undefined;
    /** 文本段的默认解析模式（缺省 user；平台标记 __system='1' 时强制 internal） */
    textMode?: ParseMode;
}

function asData(segment: PlatformSegmentInput): Record<string, unknown> {
    return segment && typeof segment === 'object' && segment.data && typeof segment.data === 'object'
        ? segment.data
        : {};
}

function textOf(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function jsonOf(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return String(value);
    }
}

function pushText(parts: Part[], text: string): void {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') last.text += text;
    else parts.push({ type: 'text', text });
}

function fallbackUnknown(parts: Part[], tag: string, data: unknown): void {
    // 内容永不静默丢失：无法结构化的段整体保留为 unknown（文本投影可见原始 JSON）
    parts.push({ type: 'unknown', tag, content: jsonOf(data).slice(0, 4000) });
}

/** 单段解析；返回 0..n 个 Part（文本段可能解析出多个标签 part） */
export function parseSegment(segment: PlatformSegmentInput, ctx: SegmentParseContext = {}, index = 0): Part[] {
    const parts: Part[] = [];
    if (!segment || typeof segment.type !== 'string') return parts;
    const data = asData(segment);
    const type = segment.type;
    switch (type) {
        case 'text': {
            const mode: ParseMode = textOf(data.__system) === '1' ? 'internal' : (ctx.textMode || 'user');
            const parsed = parseText(textOf(data.text), mode);
            for (const part of parsed) {
                if (part.type === 'text') pushText(parts, part.text);
                else parts.push(part);
            }
            return parts;
        }
        case 'at':
        case 'mention': {
            const qq = data.qq ?? data.user_id ?? data.id;
            if (String(qq).toLowerCase() === 'all') {
                parts.push({ type: 'mention', id: 'all', all: true });
                return parts;
            }
            const normalized = ctx.uid?.(qq);
            const id = textOf(normalized) || textOf(qq);
            if (id) parts.push({ type: 'mention', id });
            else fallbackUnknown(parts, 'at', data);
            return parts;
        }
        case 'poke': {
            const normalized = ctx.uid?.(data.qq ?? data.user_id ?? data.id);
            const id = textOf(normalized) || textOf(data.qq ?? data.user_id ?? data.id);
            if (id) parts.push({ type: 'poke', id });
            else fallbackUnknown(parts, 'poke', data);
            return parts;
        }
        case 'reply':
        case 'quote': {
            const normalized = ctx.quoteId?.(data.id ?? data.message_id);
            const id = textOf(normalized) || textOf(data.id ?? data.message_id);
            if (id) parts.push({ type: 'quote', id });
            else fallbackUnknown(parts, 'quote', data);
            return parts;
        }
        case 'image': {
            const registered = ctx.image?.(segment, index);
            const ref = textOf(registered?.ref) || textOf(data.file) || textOf(data.url);
            if (!ref) {
                fallbackUnknown(parts, 'image', data);
                return parts;
            }
            const desc = textOf(registered?.desc);
            parts.push(desc ? { type: 'image', ref, desc } : { type: 'image', ref });
            return parts;
        }
        case 'record':
        case 'video': {
            const kind = type === 'record' ? 'record' : 'video';
            const registered = ctx.media?.(segment, kind, index);
            const handle = textOf(registered?.handle) || textOf(data.file) || textOf(data.url);
            if (!handle) {
                fallbackUnknown(parts, kind, data);
                return parts;
            }
            const summary = textOf(registered?.summary) || textOf(data.name) || textOf(data.title);
            parts.push(summary ? { type: kind, handle, summary } : { type: kind, handle });
            return parts;
        }
        case 'file': {
            const registered = ctx.media?.(segment, 'file', index);
            const handle = textOf(registered?.handle) || textOf(data.file) || textOf(data.url);
            if (!handle) {
                fallbackUnknown(parts, 'file', data);
                return parts;
            }
            const summary = textOf(registered?.summary) || textOf(data.name) || textOf(data.title);
            parts.push(summary ? { type: 'file', handle, summary } : { type: 'file', handle });
            return parts;
        }
        case 'face': {
            const id = textOf(data.id);
            const name = textOf(ctx.faceName?.(id)) || (id ? `unknown sticker ${id}` : '');
            if (!name) {
                fallbackUnknown(parts, 'face', data);
                return parts;
            }
            parts.push({ type: 'face', name });
            return parts;
        }
        case 'forward': {
            const normalized = ctx.forwardId?.(data.id ?? data.res_id);
            const id = textOf(normalized) || textOf(data.id ?? data.res_id);
            if (id) parts.push({ type: 'forward', id });
            else fallbackUnknown(parts, 'forward', data);
            return parts;
        }
        case 'node': {
            // 合并转发节点：无法展开时不丢弃内容，整体作为 unknown 保留（可回查 JSON）
            fallbackUnknown(parts, 'node', data);
            return parts;
        }
        case 'markdown': {
            const text = textOf(data.content) || textOf(data.data) || textOf(data.text);
            if (text) parts.push({ type: 'markdown', text });
            else fallbackUnknown(parts, 'markdown', data);
            return parts;
        }
        default: {
            // json / xml / music / card / dice / rps / 未来新类型：内容永不丢
            fallbackUnknown(parts, type, data);
            return parts;
        }
    }
}

/** 批量解析（保持顺序；相邻 text 合并） */
export function parseSegments(segments: PlatformSegmentInput[], ctx: SegmentParseContext = {}): Part[] {
    const parts: Part[] = [];
    if (!Array.isArray(segments)) return parts;
    segments.forEach((segment, index) => {
        const one = parseSegment(segment, ctx, index);
        for (const part of one) {
            if (part.type === 'text') pushText(parts, part.text);
            else parts.push(part);
        }
    });
    return parts;
}

// ---------------- CQ 码入站（宽松兼容） ----------------

const CQ_ENTITY_MAP: Record<string, string> = {
    '&#91;': '[',
    '&#93;': ']',
    '&#44;': ',',
    '&amp;': '&',
};

function decodeCQValue(value: string): string {
    return String(value ?? '').replace(/&#91;|&#93;|&#44;|&amp;/g, entity => CQ_ENTITY_MAP[entity] ?? entity);
}

const CQ_TYPE_TO_SEGMENT: Record<string, string> = {
    at: 'at',
    reply: 'reply',
    image: 'image',
    record: 'record',
    video: 'video',
    file: 'file',
    face: 'face',
    poke: 'poke',
    forward: 'forward',
    markdown: 'markdown',
    json: 'json',
    music: 'music',
    node: 'node',
    dice: 'dice',
    rps: 'rps',
};

/** CQ 字符串 → 平台段（供旧调用点/文本入口过渡使用） */
export function parseCQString(cq: string, ctx: SegmentParseContext = {}): Part[] {
    const source = String(cq ?? '');
    if (!source) return [];
    const segments: PlatformSegmentInput[] = [];
    let text = '';
    let i = 0;
    while (i < source.length) {
        if (source[i] === '[' && source.slice(i, i + 4) === '[CQ:') {
            const end = source.indexOf(']', i);
            if (end > i) {
                if (text) {
                    segments.push({ type: 'text', data: { text: decodeCQValue(text) } });
                    text = '';
                }
                const inner = source.slice(i + 4, end);
                const comma = inner.indexOf(',');
                const type = (comma >= 0 ? inner.slice(0, comma) : inner).trim().toLowerCase();
                const data: Record<string, unknown> = {};
                if (comma >= 0) {
                    for (const pair of inner.slice(comma + 1).split(',')) {
                        const eq = pair.indexOf('=');
                        if (eq < 0) continue;
                        data[pair.slice(0, eq).trim()] = decodeCQValue(pair.slice(eq + 1));
                    }
                }
                segments.push({ type: CQ_TYPE_TO_SEGMENT[type] || type, data });
                i = end + 1;
                continue;
            }
        }
        text += source[i];
        i++;
    }
    if (text) segments.push({ type: 'text', data: { text: decodeCQValue(text) } });
    return parseSegments(segments, ctx);
}
