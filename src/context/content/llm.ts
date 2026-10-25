// Part[] → 模型请求内容（OpenAI 兼容 / Anthropic Messages）。
// 规则（见 .dev/context-content-part-mapping.md §二/§七）：
// - 图片/头像等在有视觉能力时输出「规范文本标签 + 图片内容块」，无视觉时只输出文本标签；
// - 文本标签永远保留 CIR 引用，让多模态模型看完图仍知道 id；
// - 纯文本会话拿到的就是规范文本投影，不产生内容块。
import type { Part } from "../events";

import {
    getDescriptorForPart,
    LLMCaps,
    LLMImagePiece,
    LLMPiece,
    MediaResolvers,
} from "./descriptors";

export type LLMDialect = 'openai' | 'anthropic';

export type LLMContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } };

export const DEFAULT_LLM_CAPS: LLMCaps = { vision: false };

function pushTextPiece(pieces: LLMPiece[], text: string): void {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else pieces.push({ kind: 'text', text });
}

/**
 * 中性投影：文本/标签 → text piece；有视觉且能取到 URL 的图片/头像 → image piece
 * （image piece 之前总会先补一条规范文本标签，保证 id 可见）。
 */
export function toLLMPieces(parts: Part[], caps: LLMCaps = DEFAULT_LLM_CAPS, resolve: MediaResolvers = {}): LLMPiece[] {
    const pieces: LLMPiece[] = [];
    if (!Array.isArray(parts)) return pieces;
    for (const part of parts) {
        const descriptor = getDescriptorForPart(part);
        const projected = descriptor.toLLM(part, caps, resolve);
        if (typeof projected === 'string') {
            pushTextPiece(pieces, projected);
            continue;
        }
        // 图片类：先放规范文本标签，再放图片块（INV：id 始终对模型可见）
        pushTextPiece(pieces, descriptor.renderText(part));
        pieces.push(projected);
    }
    return pieces;
}

/** 只取文本投影（无视觉/纯文本 API/PE 降级用；图片 id 仍以规范标签保留） */
export function toLLMText(parts: Part[], caps: LLMCaps = DEFAULT_LLM_CAPS, resolve: MediaResolvers = {}): string {
    return toLLMPieces(parts, caps, resolve)
        .filter((piece): piece is Extract<LLMPiece, { kind: 'text' }> => piece.kind === 'text')
        .map(piece => piece.text)
        .join('');
}

/** 把 data: URI 拆成 Anthropic base64 图片块；不是 data URI 返回 null */
function dataUriToAnthropicBlock(url: string): LLMContentBlock | null {
    const match = /^data:([^;,]+?)(;base64)?,([\s\S]*)$/.exec(url);
    if (!match) return null;
    return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[3] },
    };
}

function imagePieceToBlock(piece: LLMImagePiece, dialect: LLMDialect): LLMContentBlock {
    if (dialect === 'anthropic') {
        const asData = dataUriToAnthropicBlock(piece.url);
        if (asData) return asData;
        return { type: 'image', source: { type: 'url', url: piece.url } };
    }
    return { type: 'image_url', image_url: { url: piece.url } };
}

/** 始终返回内容块数组（编译器的统一出口） */
export function toLLMBlocks(
    parts: Part[],
    caps: LLMCaps = DEFAULT_LLM_CAPS,
    dialect: LLMDialect = 'openai',
    resolve: MediaResolvers = {},
): LLMContentBlock[] {
    return toLLMPieces(parts, caps, resolve).map(piece =>
        piece.kind === 'text' ? { type: 'text' as const, text: piece.text } : imagePieceToBlock(piece, dialect),
    );
}

/**
 * 兼容两种消费方式：
 * - 无图片内容块时返回字符串（等价于既有 `content: string` 请求形态）；
 * - 有内容块时返回块数组。
 */
export function toLLM(
    parts: Part[],
    caps: LLMCaps = DEFAULT_LLM_CAPS,
    dialect: LLMDialect = 'openai',
    resolve: MediaResolvers = {},
): string | LLMContentBlock[] {
    const blocks = toLLMBlocks(parts, caps, dialect, resolve);
    if (blocks.every(block => block.type === 'text')) {
        return blocks.map(block => (block.type === 'text' ? block.text : '')).join('');
    }
    return blocks;
}
