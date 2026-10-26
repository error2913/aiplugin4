// 工具结果归一化：MCP content block / 旧 ToolContentPart / 纯字符串 → Part[]。
//
// 安全口径（映射表 §六/§三）：工具结果默认按 external 解析，`@全体`、引用、表情等可发送标签
// 一律降级为字面量文本；媒体（图片/语音/视频）是可显式允许的例外，但必须经过注入回调登记实体
// 变成 CIR 引用 / 句柄后才进 Part —— **base64 绝不进账本**，无法登记时只保留元数据说明。
import type { Part } from "../events";

import { ParseMode, sanitizeTagValue } from "./descriptors";
import { parseText } from "./text_parse";

/** 旧版 ToolContentPart（OpenAI 多模态内容块） */
export interface LegacyToolContentPart {
    type: string;
    text?: string;
    image_url?: { url?: string };
}

/** MCP 内容块（宽松结构：不同服务器字段略有差异） */
export interface McpContentBlock {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    url?: string;
    uri?: string;
    name?: string;
    resource?: {
        uri?: string;
        name?: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    };
    [key: string]: unknown;
}

/** 媒体登记回调：把外部数据变成可持久化引用（不登记 = 只保留元数据） */
export interface ToolResultIngest {
    image?(input: { url?: string; data?: string; mimeType?: string; name?: string }, index: number): { ref: string; desc?: string } | null | undefined;
    media?(input: { kind: 'record' | 'video'; url?: string; data?: string; mimeType?: string; name?: string }, index: number): { handle: string; summary?: string } | null | undefined;
    resource?(input: McpContentBlock, index: number): { uri: string; name?: string; mime?: string } | null | undefined;
}

export interface ToolResultInput {
    /** 工具返回的主文本（可能含标签） */
    text?: string;
    /** 旧版结构化内容块 */
    contentParts?: LegacyToolContentPart[];
    /** MCP content 数组 */
    mcpContent?: unknown[];
    /** MCP structuredContent（JSON 对象） */
    structuredContent?: unknown;
}

export interface ToolResultNormalizeOptions {
    /** 默认 external；显式允许时 text 中的 [img:] 会升级为 image/avatar part */
    allowImageRefs?: boolean;
    /** 未登记 base64 时是否保留「未入库」说明文本（默认 true，保证信息不丢） */
    noteUnregisteredMedia?: boolean;
    ingest?: ToolResultIngest;
}

const DEFAULT_OPTIONS: Required<Pick<ToolResultNormalizeOptions, 'allowImageRefs' | 'noteUnregisteredMedia'>> = {
    allowImageRefs: true,
    noteUnregisteredMedia: true,
};

function pushText(parts: Part[], text: string): void {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') last.text += text;
    else parts.push({ type: 'text', text });
}

function jsonOf(value: unknown, limit = 4000): string {
    try {
        return (JSON.stringify(value) ?? '').slice(0, limit);
    } catch {
        return String(value).slice(0, limit);
    }
}

function safePercentLength(value: string | undefined): number {
    return value ? value.length : 0;
}

const MEDIA_TAG_RE = /[\[［]img[:：][^\]］]+[\]］]/g;

/**
 * 工具返回文本按 external 解析后，把其中的 `[img:…]` 显式允许为媒体 part。
 * 其余可发送标签（at/poke/quote/face）保持字面量文本，防止外部数据诱导发送。
 */
function upgradeImageRefs(parts: Part[]): Part[] {
    const out: Part[] = [];
    for (const part of parts) {
        if (part.type !== 'text') {
            out.push(part);
            continue;
        }
        const source = part.text;
        let cursor = 0;
        MEDIA_TAG_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = MEDIA_TAG_RE.exec(source)) !== null) {
            if (match.index > cursor) pushText(out, source.slice(cursor, match.index));
            const parsed = parseText(match[0], 'model-output');
            const media = parsed.find(p => p.type === 'image' || p.type === 'avatar' || p.type === 'group_avatar');
            if (media) {
                out.push(media);
            } else {
                // 解析失败：保持字面量（转义投影时不会被当标签）
                pushText(out, match[0]);
            }
            cursor = match.index + match[0].length;
        }
        if (cursor < source.length) pushText(out, source.slice(cursor));
    }
    return out;
}

function textParts(text: string | undefined, mode: ParseMode, opts: Required<Pick<ToolResultNormalizeOptions, 'allowImageRefs'>>): Part[] {
    const source = String(text ?? '');
    if (!source) return [];
    const parsed = parseText(source, mode);
    return opts.allowImageRefs ? upgradeImageRefs(parsed) : parsed;
}

function registeredImagePart(
    block: { url?: string; data?: string; mimeType?: string; name?: string },
    index: number,
    ingest: ToolResultIngest | undefined,
    note: boolean,
): Part[] {
    const registered = ingest?.image?.(block, index);
    const ref = registered?.ref ? sanitizeTagValue(registered.ref) : '';
    if (ref) {
        const desc = registered?.desc ? sanitizeTagValue(registered.desc) : '';
        return [desc ? { type: 'image', ref, desc } : { type: 'image', ref }];
    }
    const url = sanitizeTagValue(block.url);
    if (url && !url.startsWith('data:')) return [{ type: 'image', ref: url }];
    const mime = sanitizeTagValue(block.mimeType) || 'unknown type';
    const bytes = safePercentLength(block.data);
    return note
        ? [{ type: 'text', text: `[image: ${mime}, about ${bytes} chars (not registered; original not stored)]` }]
        : [];
}

function registeredMediaPart(
    kind: 'record' | 'video',
    block: { url?: string; data?: string; mimeType?: string; name?: string },
    index: number,
    ingest: ToolResultIngest | undefined,
    note: boolean,
): Part[] {
    const registered = ingest?.media?.({ kind, ...block }, index);
    const handle = registered?.handle ? sanitizeTagValue(registered.handle) : '';
    if (handle) {
        const summary = registered?.summary ? sanitizeTagValue(registered.summary) : (block.name ? sanitizeTagValue(block.name) : '');
        return [summary ? { type: kind, handle, summary } : { type: kind, handle }];
    }
    const url = sanitizeTagValue(block.url);
    if (url && !url.startsWith('data:')) return [{ type: kind, handle: url }];
    const mime = sanitizeTagValue(block.mimeType) || 'unknown type';
    const bytes = safePercentLength(block.data);
    return note
        ? [{ type: 'text', text: `[${kind === 'record' ? 'voice' : 'video'}: ${mime}, about ${bytes} chars (not registered; original not stored)]` }]
        : [];
}

function normalizeLegacyPart(part: LegacyToolContentPart, index: number, opts: ToolResultNormalizeOptions): Part[] {
    if (!part || typeof part.type !== 'string') return [];
    if (part.type === 'text') {
        return textParts(part.text, 'external', { allowImageRefs: opts.allowImageRefs ?? DEFAULT_OPTIONS.allowImageRefs });
    }
    if (part.type === 'image_url') {
        return registeredImagePart(
            { url: part.image_url?.url },
            index,
            opts.ingest,
            opts.noteUnregisteredMedia ?? DEFAULT_OPTIONS.noteUnregisteredMedia,
        );
    }
    return [{ type: 'unknown', tag: sanitizeTagValue(part.type) || 'unknown', content: jsonOf(part) }];
}

function normalizeMcpBlock(block: unknown, index: number, opts: ToolResultNormalizeOptions): Part[] {
    if (!block || typeof block !== 'object') {
        return [{ type: 'unknown', tag: 'mcp', content: jsonOf(block) }];
    }
    const value = block as McpContentBlock;
    const type = typeof value.type === 'string' ? value.type : '';
    const allowImageRefs = opts.allowImageRefs ?? DEFAULT_OPTIONS.allowImageRefs;
    const note = opts.noteUnregisteredMedia ?? DEFAULT_OPTIONS.noteUnregisteredMedia;
    switch (type) {
        case 'text': {
            return textParts(value.text, 'external', { allowImageRefs });
        }
        case 'image': {
            return registeredImagePart(
                { url: value.url || value.uri, data: value.data, mimeType: value.mimeType, name: value.name },
                index,
                opts.ingest,
                note,
            );
        }
        case 'audio': {
            return registeredMediaPart(
                'record',
                { url: value.url || value.uri, data: value.data, mimeType: value.mimeType, name: value.name },
                index,
                opts.ingest,
                note,
            );
        }
        case 'video': {
            return registeredMediaPart(
                'video',
                { url: value.url || value.uri, data: value.data, mimeType: value.mimeType, name: value.name },
                index,
                opts.ingest,
                note,
            );
        }
        case 'resource': {
            const resource = value.resource || {};
            const parts: Part[] = [];
            const registered = opts.ingest?.resource?.(value, index);
            const uri = sanitizeTagValue(registered?.uri || resource.uri);
            const name = sanitizeTagValue(registered?.name || resource.name || value.name);
            const mime = sanitizeTagValue(registered?.mime || resource.mimeType || value.mimeType);
            if (resource.text) parts.push(...textParts(resource.text, 'external', { allowImageRefs }));
            if (uri) {
                const part: Part = { type: 'resource', uri };
                if (name) part.name = name;
                if (mime) part.mime = mime;
                parts.push(part);
            } else if (resource.blob) {
                // 内嵌 blob：不把 base64 写进账本，只保留元数据说明
                parts.push({ type: 'unknown', tag: 'resource', content: `[blob ${mime || 'unknown type'}, about ${resource.blob.length} chars]` });
            } else {
                parts.push({ type: 'unknown', tag: 'resource', content: jsonOf(value) });
            }
            return parts;
        }
        case 'embedded_resource':
        case 'embeddedResource': {
            return normalizeMcpBlock({ ...value, type: 'resource' }, index, opts);
        }
        default: {
            // 未知块：内容永不静默丢（unknown 文本投影可见 JSON）
            return [{ type: 'unknown', tag: sanitizeTagValue(type) || 'unknown', content: jsonOf(value) }];
        }
    }
}

/** 旧版 ToolContentPart[] → Part[]（单个入口，便于测试/迁移复用） */
export function normalizeLegacyContentParts(parts: LegacyToolContentPart[] | undefined, opts: ToolResultNormalizeOptions = {}): Part[] {
    const out: Part[] = [];
    (parts || []).forEach((part, index) => {
        for (const one of normalizeLegacyPart(part, index, opts)) {
            if (one.type === 'text') pushText(out, one.text);
            else out.push(one);
        }
    });
    return out;
}

/** MCP content 数组 → Part[] */
export function normalizeMcpContent(content: unknown[] | undefined, opts: ToolResultNormalizeOptions = {}): Part[] {
    const out: Part[] = [];
    (content || []).forEach((block, index) => {
        for (const one of normalizeMcpBlock(block, index, opts)) {
            if (one.type === 'text') pushText(out, one.text);
            else out.push(one);
        }
    });
    return out;
}

/**
 * 工具结果统一入口：字符串 + 旧 contentParts + MCP content + structuredContent。
 * 文本去重：`text` 与 MCP/旧内容里的同文 text 只保留一次（避免工具结果双份入账）。
 */
export function normalizeToolResult(input: ToolResultInput | string | undefined | null, opts: ToolResultNormalizeOptions = {}): Part[] {
    if (input === undefined || input === null) return [];
    const value: ToolResultInput = typeof input === 'string' ? { text: input } : input;
    const out: Part[] = [];
    const seenText = new Set<string>();
    const pushUnique = (part: Part) => {
        if (part.type === 'text') {
            if (seenText.has(part.text)) return;
            seenText.add(part.text);
            pushText(out, part.text);
            return;
        }
        out.push(part);
    };
    for (const part of textParts(value.text, 'external', { allowImageRefs: opts.allowImageRefs ?? DEFAULT_OPTIONS.allowImageRefs })) {
        pushUnique(part);
    }
    for (const part of normalizeLegacyContentParts(value.contentParts, opts)) pushUnique(part);
    for (const part of normalizeMcpContent(value.mcpContent, opts)) pushUnique(part);
    if (value.structuredContent !== undefined && value.structuredContent !== null) {
        const text = jsonOf(value.structuredContent);
        if (text) pushUnique({ type: 'text', text });
    }
    return out;
}

/** 对外暴露：把某段工具文本按 external 策略解析（可发送标签保持字面量文本） */
export function externalTextToParts(text: string): Part[] {
    return parseText(String(text ?? ''), 'external');
}
