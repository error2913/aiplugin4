// MCP 结果归一化：把标准 MCP content block 转成文本 + 图片引用 + 资源引用。
// 不针对任何具体工具名做特化，保持通用 MCP 客户端纯净。
import Logger from "../../logger";
import Image from "../../resource/image";
import { ImageHost } from "../../resource/image_host";
import type { ImageSource } from "../../resource/image_host";
import { ToolContentPart } from "../types";

import { MCPCallResult, MCPImageReference, MCPNormalizedResult, MCPResourceReference } from "./types";

const log = Logger.withTag('mcp');

/** 结果归一化选项：文件/图片产出时的来源元数据（元数据，不是标签） */
export interface MCPNormalizeOptions {
    /** 工具调用所在的会话上下文（平台/群/用户/会话/时间） */
    source?: ImageSource;
    /** MCP 工具名（tools/call 的 name） */
    tool?: string;
    /** MCP 服务器名 */
    server?: string;
}

function normalizeBase64(text: string): string {
    const value = String(text || '').trim();
    if (/^data:[^,]+;base64,/i.test(value)) return value.slice(value.indexOf(',') + 1);
    return value;
}

function looksLikeBase64(text: string): boolean {
    const compact = normalizeBase64(text).replace(/\s+/g, '');
    return compact.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function inferFormat(mimeType?: string): string | undefined {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpeg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return undefined;
}

/**
 * 保存 MCP image block 为插件图片：
 * - 来源元数据（platform/group/user/session/at/tool=server/via）写入 sourceMeta，用于图床入库与类型标签；
 * - 配了图床时异步入库（成功后清空内存 base64，文件由图床保存）。
 */
function saveMCPImage(data: string, mimeType?: string, opts?: MCPNormalizeOptions): MCPImageReference {
    const img = new Image();
    img.imageId = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    img.base64 = normalizeBase64(data);
    img.format = inferFormat(mimeType) || 'png';
    img.description = `MCP 图片[img:${img.imageId}]`;
    // 尺寸：模型侧有单边上限（见 19-模型图片尺寸上限与图源方案），能解析就记下，供选源判断
    try {
        const size = Image.parseSizeFromBase64(img.base64);
        if (size) {
            img.width = size.w;
            img.height = size.h;
        }
    } catch { /* 头部解析失败：尺寸保持未知（选源会保守处理） */ }
    // 来源元数据：工具调用所在的群/会话；MCP 图片 tool=实际工具名、server=服务器名（都是元数据，不写标签）
    const source: Record<string, unknown> = {
        platform: opts?.source?.platform,
        group_id: opts?.source?.group_id,
        user_id: opts?.source?.user_id,
        session_id: opts?.source?.session_id,
        message_id: opts?.source?.message_id,
        at: opts?.source?.at || Date.now(),
        tool: opts?.tool || 'mcp',
        server: opts?.server,
        via: 'tool',
    };
    for (const key of Object.keys(source)) {
        if (source[key] === undefined || source[key] === null || source[key] === '') delete source[key];
    }
    if (opts?.source?.session_id) img.sourceSessionId = opts.source.session_id;
    try { img.sourceMeta = JSON.stringify(source); } catch (_e) { img.sourceMeta = ''; }
    // 先登记内存：工具结果本轮就能通过 Image.resolveRef 找到；不先写 storage，避免 base64 短暂落盘
    Image.imageMap[img.imageId] = img;
    if (!ImageHost.enabled) {
        Image.save(img);
    } else {
        // 配了图床：异步入库；成功/失败后再落盘（成功的落盘不含 base64）
        void img.adoptBase64ToHost()
            .then(() => { Image.save(img); })
            .catch(() => { Image.save(img); });
    }
    return { imageId: img.imageId, src: img.src, mimeType };
}

/** 提取 MCP 结果中的文本内容（兼容 text 块、structuredContent） */
export function mcpText(result: MCPCallResult | null | undefined): string {
    if (!result) return '';
    const texts = Array.isArray(result.content)
        ? result.content.map(block => (block && typeof block.text === 'string' ? block.text : '')).filter(Boolean)
        : [];
    if (texts.length > 0) return texts.join('\n');
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
        try {
            return JSON.stringify(result.structuredContent);
        } catch (_e) {
            return String(result.structuredContent);
        }
    }
    return '';
}

/** 通用容错：MCP 可能以 text 返回 base64 的旧后端，仍可保存为图片 */
export function extractMCPImage(result: MCPCallResult | null | undefined, treatTextAsBase64 = false): { data: string; mimeType?: string } | null {
    const blocks = Array.isArray(result && result.content) ? result!.content! : [];
    for (const block of blocks) {
        if (block && block.type === 'image' && typeof block.data === 'string' && block.data) {
            return { data: normalizeBase64(block.data), mimeType: block.mimeType };
        }
    }
    if (treatTextAsBase64) {
        for (const block of blocks) {
            if (block && typeof block.text === 'string' && looksLikeBase64(block.text)) {
                return { data: normalizeBase64(block.text), mimeType: block.mimeType };
            }
        }
    }
    const structured = result && result.structuredContent;
    if (structured && typeof structured === 'object') {
        const base64 = (structured as any).base64 || (structured as any).data;
        if (typeof base64 === 'string' && looksLikeBase64(base64)) {
            return { data: normalizeBase64(base64), mimeType: (structured as any).mimeType || (structured as any).mime };
        }
    }
    return null;
}

/**
 * 将 MCP tools/call 原始结果归一化为通用文本 + 图片引用 + 资源引用。
 * 文本中会保留 [img:xxx] / [mcp://...] 引用，供非多模态模型理解；
 * 图片引用额外保留 src，供多模态模型直接注入 image_url。
 * opts 提供工具调用来源（群/会话/工具名/服务器名），用于图片入库的来源元数据。
 */
export function normalizeMCPResult(result: MCPCallResult | null | undefined, opts?: MCPNormalizeOptions): MCPNormalizedResult {
    if (!result) return { text: '', images: [], resources: [] };

    const blocks = Array.isArray(result.content) ? result.content : [];
    const textParts: string[] = [];
    const images: MCPImageReference[] = [];
    const resources: MCPResourceReference[] = [];

    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
            continue;
        }

        if (block.type === 'image' && typeof block.data === 'string' && block.data) {
            const ref = saveMCPImage(block.data, block.mimeType, opts);
            images.push(ref);
            textParts.push(`图片[img:${ref.imageId}]`);
            continue;
        }

        if (block.type === 'resource') {
            const res = block.resource && typeof block.resource === 'object' ? block.resource : block;
            const uri = typeof res.uri === 'string' ? res.uri : '';
            if (uri) {
                const name = typeof res.name === 'string' ? res.name : uri.split('/').pop();
                resources.push({ uri, mimeType: res.mimeType, name });
            }
            if (typeof res.text === 'string' && res.text) {
                textParts.push(res.text);
            } else if (uri) {
                textParts.push(`资源[${uri}]`);
            }
            continue;
        }

        if ((block.type === 'audio' || block.type === 'video') && typeof block.data === 'string' && block.data) {
            log.debug(`MCP 返回 ${block.type} 内容，当前仅记录资源引用，不自动保存`);
            const uri = block.uri || `mcp://inline/${block.type}`;
            resources.push({ uri, mimeType: block.mimeType, name: block.type });
            textParts.push(`资源[${uri}]`);
        }
    }

    let text = textParts.join('\n');
    if (!text && result.structuredContent !== undefined && result.structuredContent !== null) {
        try {
            text = JSON.stringify(result.structuredContent);
        } catch (_e) {
            text = String(result.structuredContent);
        }
    }

    return { text, images, resources };
}

/** 从归一化结果构造 OpenAI 兼容多模态内容块 */
export function buildContentParts(normalized: MCPNormalizedResult): ToolContentPart[] {
    const parts: ToolContentPart[] = [];
    if (normalized.text) parts.push({ type: 'text', text: normalized.text });
    for (const image of normalized.images) {
        if (image.src) parts.push({ type: 'image_url', image_url: { url: image.src } });
    }
    return parts;
}
