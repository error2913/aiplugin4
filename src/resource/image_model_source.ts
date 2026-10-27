// 模型图源（叶子，纯逻辑）：决定「这张图给模型看什么」以及图片类错误的定位。
//
// 背景（见 .dev/docs-archive/19-模型图片尺寸上限与图源方案.md）：
// - 部分视觉模型对输入图有硬限制（实测 deepseek-flash：单边 > 8192px 直接 400，且文案伪装成
//   “不支持的图片格式”），插件过去把原图直接喂模型 → 会话每轮 400、静默不回复；
// - goja 无法解码/缩放图片，v2 组包又是同步纯函数 → 缩放只能交给后端（image-host `/m/<id>?max=`），
//   插件同步选源；需要内联时用预取好的变体字节。
//
// 本叶子不 import Image（避免环）：Image 负责把自身事实组装成 `ModelSourceFacts` 再调这里。
import { parseImageErrorPosition } from "../model/api_error";

import { isTemporaryUrl } from "./image_url";

/** 模型图片限制：accept = 单边接受上限；target = 希望交给模型的长边（0/缺省表示不缩放） */
export interface ImageLimits {
    maxSide?: number;
    targetSide?: number;
}

/** 单张图片的选源事实（由 Image 组装；纯数据，便于单测） */
export interface ModelSourceFacts {
    imageId: string;
    /** url / local / base64，与 Image.type 一致 */
    kind: 'url' | 'local' | 'base64';
    isAvatar: boolean;
    /** 已入图床（hostedId && ImageHost.enabled） */
    hosted: boolean;
    /** 后端是否支持 /m 模型变体（capabilities 含 model-variant） */
    backendVariant: boolean;
    /** 同步可用的模型变体 URL（空 = 图床对外地址不可用/未托管） */
    variantUrl: string;
    /** 预取好的模型变体 data URI（空 = 未预取） */
    inlineVariantUrl: string;
    /** 现状可发送地址：图床对外地址或原 URL */
    remoteUrl: string;
    /** URL 已确认不可用 */
    urlUnusable: boolean;
    /** 已有 base64 的 data URI（空 = 无字节） */
    base64Url: string;
    /** 已知原始尺寸（null/undefined = 未知） */
    size?: { w: number; h: number } | null;
    /** 曾被模型拒绝（超尺寸/不可解码） */
    modelUnsafe: boolean;
    /** 模型接受上限（px） */
    maxSide: number;
    /** 本轮已决定把图片降级为文本（错误恢复重发用） */
    imagesAsText?: boolean;
    /** 本图被要求改用内联字节（模型 URL 取图失败后 markModelDownloadFailures 的 retryInline） */
    forceInline?: boolean;
}

export type ModelSourceReason =
    | 'unsafe'
    | 'broken'
    | 'avatar'
    | 'images-as-text'
    | 'local'
    | 'hosted-variant'
    | 'hosted-inline'
    | 'hosted-legacy'
    | 'oversize'
    | 'base64'
    | 'url';

export interface ModelSourceDecision {
    kind: 'url' | 'base64' | 'none';
    src?: string;
    reason: ModelSourceReason;
}

/**
 * 选源决策（纯函数、无 IO）。规则见方案 §5.3 决策表：
 * 1. 已标 modelUnsafe / URL 已坏 / 本轮要求全降级 → 只留文本标签；
 * 2. 头像 → qlogo 原地址（本身 ≤640，安全）；
 * 3. 图床 + 后端支持变体 → 变体 URL；对外地址不可用时用预取的变体内联；
 * 4. 图床 + 旧后端 → 现状 URL（INV-5：不劣化，交给 P0 兜底）；
 * 5. 非图床 base64 → 尺寸已知且超限则文本，否则原 data URI；
 * 6. 非图床 URL → 原 URL（现状）。
 */
export function decideModelSource(f: ModelSourceFacts): ModelSourceDecision {
    if (f.modelUnsafe) return { kind: 'none', reason: 'unsafe' };
    if (f.urlUnusable) return { kind: 'none', reason: 'broken' };
    // imagesAsText：本轮把「URL 来源」的图降级为文本（旧语义；base64 图有确定字节，交给尺寸闸门判断）
    if (f.imagesAsText && !f.isAvatar && f.kind === 'url') return { kind: 'none', reason: 'images-as-text' };
    if (f.isAvatar) {
        return f.remoteUrl ? { kind: 'url', src: f.remoteUrl, reason: 'avatar' } : { kind: 'none', reason: 'unsafe' };
    }
    if (f.kind === 'local') return { kind: 'none', reason: 'local' };

    if (f.hosted) {
        // 模型报「下载失败」后的内联重试：有字节就直接内联
        if (f.forceInline && f.base64Url) return { kind: 'base64', src: f.base64Url, reason: 'hosted-inline' };
        if (f.backendVariant) {
            if (f.variantUrl) return { kind: 'url', src: f.variantUrl, reason: 'hosted-variant' };
            if (f.inlineVariantUrl) return { kind: 'base64', src: f.inlineVariantUrl, reason: 'hosted-inline' };
            // 有变体能力但对外地址与预取都不可用：不赌原图（可能超限），只留文本
            return { kind: 'none', reason: 'unsafe' };
        }
        // 旧后端：对外地址不可用但有内联字节 → 沿用旧的 b64 兜底
        if (f.base64Url && !f.remoteUrl) return { kind: 'base64', src: f.base64Url, reason: 'hosted-inline' };
        // 旧后端：保持旧行为（原图 URL / 原始直链）
        return f.remoteUrl && !isTemporaryUrl(f.remoteUrl)
            ? { kind: 'url', src: f.remoteUrl, reason: 'hosted-legacy' }
            : { kind: 'none', reason: 'broken' };
    }

    if (f.kind === 'base64') {
        if (f.size && exceedsMaxSide(f.size, f.maxSide)) return { kind: 'none', reason: 'oversize' };
        return f.base64Url ? { kind: 'base64', src: f.base64Url, reason: 'base64' } : { kind: 'none', reason: 'unsafe' };
    }

    // 非图床 URL：无法同步取尺寸，维持现状；模型侧拒绝由 P0 兜底
    return f.remoteUrl && !f.urlUnusable ? { kind: 'url', src: f.remoteUrl, reason: 'url' } : { kind: 'none', reason: 'broken' };
}

/** 单边是否超过接受上限（maxSide<=0 表示不检查） */
export function exceedsMaxSide(size: { w: number; h: number }, maxSide: number): boolean {
    if (!maxSide || maxSide <= 0) return false;
    return size.w > maxSide || size.h > maxSide;
}

/**
 * 从图床 URL 里取出 hostedId（sha256）：支持
 * `/i/<sha>`、`/m/<sha>?max=…`、`/i/<sha>/b64`、`/m/<sha>/b64?max=…`。
 * 用于模型下载失败时把 URL 映射回图片（20 号方案 P0-C）。
 */
export function hostedIdFromImageUrl(url: string): string {
    const m = /\/[im]\/([0-9a-f]{64})(?:[/?]|$)/i.exec(String(url ?? ''));
    return m ? m[1].toLowerCase() : '';
}

/** URL 是否指向该 hostedId（/i 或 /m，含 b64 出口与查询串） */
export function isHostedImageUrlOf(url: string, hostedId: string): boolean {
    if (!hostedId) return false;
    return hostedIdFromImageUrl(url) === hostedId.toLowerCase();
}

// ---------------------------------------------------------------------------
// 图片头解析（无解码依赖：只读前若干字节）
// ---------------------------------------------------------------------------

/** 从图片头部字节解析尺寸；不认识返回 null */
export function parseImageSize(bytes: Uint8Array | number[]): { w: number; h: number } | null {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (b.length < 10) return null;

    // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR(长度4+类型4) → 宽高在 16/20
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        if (b.length < 24) return null;
        return { w: u32be(b, 16), h: u32be(b, 20) };
    }
    // GIF87a / GIF89a → 逻辑屏宽高 u16le(6)/u16le(8)
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { w: u16le(b, 6), h: u16le(b, 8) };
    }
    // BMP: 'BM' → 宽 i32le(18)，高 i32le(22)（负数表示自上而下）
    if (b[0] === 0x42 && b[1] === 0x4d) {
        if (b.length < 26) return null;
        const w = i32le(b, 18);
        const h = Math.abs(i32le(b, 22));
        return w > 0 && h > 0 ? { w, h } : null;
    }
    // WEBP: RIFF....WEBP
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        return parseWebpSize(b);
    }
    // JPEG: FFD8FF ... SOFn
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
        return parseJpegSize(b);
    }
    return null;
}

function u16be(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function u16le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function u24le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16); }
function u32be(b: Uint8Array, i: number): number { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
function i32le(b: Uint8Array, i: number): number {
    return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
}

function parseWebpSize(b: Uint8Array): { w: number; h: number } | null {
    if (b.length < 20) return null;
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') {
        if (b.length < 30) return null;
        // 画布宽高各 24 位（存的是 值-1）
        return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
    }
    if (chunk === 'VP8L') {
        if (b.length < 25) return null;
        // 无签名 2bit + 宽 14bit + 高 14bit（小端位序）
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        const w = ((bits >>> 0) & 0x3fff) + 1;
        const h = (((bits >>> 0) >>> 14) & 0x3fff) + 1;
        return { w, h };
    }
    if (chunk === 'VP8 ') {
        if (b.length < 30) return null;
        // 帧头：3 字节 frame tag，随后 3 字节起始码 9D 01 2A，再 u16le 宽高（低 14 位）
        if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
        return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    }
    return null;
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function parseJpegSize(b: Uint8Array): { w: number; h: number } | null {
    let pos = 2;
    while (pos + 9 < b.length) {
        if (b[pos] !== 0xff) { pos++; continue; }
        const marker = b[pos + 1];
        // 填充字节 / 无长度段
        if (marker === 0xff) { pos++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
        const len = u16be(b, pos + 2);
        if (len < 2) return null;
        if (JPEG_SOF.has(marker)) {
            return { h: u16be(b, pos + 5), w: u16be(b, pos + 7) };
        }
        pos += 2 + len;
    }
    return null;
}

// ---------------------------------------------------------------------------
// base64 → 头部字节（只解码前缀，避免为取尺寸解开整张图）
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_MAP: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i++) B64_MAP[B64_CHARS[i]] = i;

/** 解码 base64 前缀到最多 maxBytes 字节（容忍 data URI 前缀/空白/缺 padding） */
export function decodeBase64Prefix(raw: string, maxBytes = 1_500_000): Uint8Array {
    let s = String(raw || '').trim();
    const comma = s.indexOf(',');
    if (s.startsWith('data:') && comma >= 0) s = s.slice(comma + 1);
    s = s.replace(/\s+/g, '');
    const out = new Uint8Array(Math.min(maxBytes, Math.floor((s.length * 3) / 4) + 3));
    let o = 0;
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < s.length && o < out.length; i++) {
        const v = B64_MAP[s[i]];
        if (v === undefined) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (buf >> bits) & 0xff;
        }
    }
    return out.subarray(0, o);
}

/** base64（可带 data URI 前缀）→ 尺寸；失败返回 null */
export function parseImageSizeFromBase64(raw: string): { w: number; h: number } | null {
    const text = String(raw || '');
    if (!text) return null;
    // JPEG 的 SOF 可能被 EXIF 推到很后面，给足前缀；其它格式前几十字节即可
    const head = text.slice(0, 2_100_000);
    return parseImageSize(decodeBase64Prefix(head));
}

// ---------------------------------------------------------------------------
// 请求图片轨迹：把模型报错里的 `.messages[N].image[K]` 映射回图片引用
// ---------------------------------------------------------------------------

export interface ImageTraceEntry {
    messageIndex: number;
    imageIndexInMessage: number;
    ref: string;
}

/**
 * 按「messages 数组顺序 + 消息内图片块顺序」给已发出的图片引用编号。
 * 调用约定：`refs` 必须是 resolver 实际产出图片块的顺序（返回 null 的不计入）。
 */
export function buildImageTrace(messages: Array<{ content: unknown }>, refs: string[]): ImageTraceEntry[] {
    const out: ImageTraceEntry[] = [];
    let cursor = 0;
    messages.forEach((message, messageIndex) => {
        const content = message ? message.content : undefined;
        if (!Array.isArray(content)) return;
        let imageIndexInMessage = 0;
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const type = (block as { type?: unknown }).type;
            if (type !== 'image_url' && type !== 'image') continue;
            const ref = refs[cursor++];
            if (ref) out.push({ messageIndex, imageIndexInMessage, ref });
            imageIndexInMessage++;
        }
    });
    return out;
}

/**
 * 模型报图片类错误时，定位应降级的图片引用：
 * 1. 有 `.messages[N].image[K]` → 用轨迹精确命中；
 * 2. 只有 `.messages[N]`（mime 直接被拒）→ 该消息内的图片（未记录消息索引时退化为全部）；
 * 3. 无轨迹/无法解析 → 空数组（调用方 giveup，保持现状）。
 */
export function locateRejectedImageRefs(message: string, trace: ImageTraceEntry[] | undefined): string[] {
    const list = Array.isArray(trace) ? trace : [];
    if (list.length === 0) return [];
    const pos = parseImageErrorPosition(message);
    if (pos && pos.imageIndex !== null) {
        const hit = list.find(e => e.messageIndex === pos.messageIndex && e.imageIndexInMessage === pos.imageIndex);
        // 命中但 ref 为空（工具 contentParts 占位图）：无法精确标记，退化为全部图片
        if (hit && hit.ref) return [hit.ref];
    }
    const out: string[] = [];
    for (const entry of list) {
        if (!entry.ref || out.includes(entry.ref)) continue;
        out.push(entry.ref);
    }
    return out;
}
