// Part[] → 规范文本 / 平台消息段 / CQ / 纯文本。
// 出口唯一：同一 Part 在每个目标上只有一种投影，转换规则全部来自 descriptors 注册表。
import type { Part } from "../events";

import {
    escapeCQValue,
    getDescriptorForPart,
    PlatformCaps,
    PlatformHooks,
    PlatformSegment,
} from "./descriptors";

/** 单个 Part 的规范文本投影（跨平台/存储调试共用的唯一写法） */
export function renderPartText(part: Part): string {
    return getDescriptorForPart(part).renderText(part);
}

/** 规范文本投影：parseText(renderText(parts)) 可往返（INV-O） */
export function renderText(parts: Part[]): string {
    if (!Array.isArray(parts)) return '';
    return parts.map(part => renderPartText(part)).join('');
}

function pushTextSegment(out: PlatformSegment[], text: string): void {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === 'text') {
        last.data = { ...last.data, text: `${String(last.data.text ?? '')}${text}` };
        return;
    }
    out.push({ type: 'text', data: { text } });
}

/**
 * Part[] → 平台消息段。
 * caps 显式 false 的能力降级为规范文本段；hooks 取不到媒体时同样降级（不静默丢）。
 */
export function renderSegments(parts: Part[], caps: PlatformCaps = {}, hooks: PlatformHooks = {}): PlatformSegment[] {
    const out: PlatformSegment[] = [];
    if (!Array.isArray(parts)) return out;
    for (const part of parts) {
        const rendered = getDescriptorForPart(part).toPlatform(part, caps, hooks);
        if (typeof rendered === 'string') pushTextSegment(out, rendered);
        else out.push(rendered);
    }
    return out;
}

function segmentToCQ(segment: PlatformSegment): string {
    const data = segment.data || {};
    switch (segment.type) {
        case 'text':
            return escapeCQValue(data.text);
        case 'at':
            return `[CQ:at,qq=${escapeCQValue(data.qq)}]`;
        case 'reply':
            return `[CQ:reply,id=${escapeCQValue(data.id)}]`;
        case 'image':
            return `[CQ:image,file=${escapeCQValue(data.file)}]`;
        case 'record':
            return `[CQ:record,file=${escapeCQValue(data.file)}]`;
        case 'video':
            return `[CQ:video,file=${escapeCQValue(data.file)}]`;
        case 'file':
            return `[CQ:file,file=${escapeCQValue(data.file)}${data.name ? `,name=${escapeCQValue(data.name)}` : ''}]`;
        case 'face':
            return `[CQ:face,id=${escapeCQValue(data.id)}]`;
        case 'poke':
            return `[CQ:poke,qq=${escapeCQValue(data.qq)}]`;
        case 'forward':
            return `[CQ:forward,id=${escapeCQValue(data.id)}]`;
        case 'markdown':
            return `[CQ:markdown,content=${escapeCQValue(data.content)}]`;
        default:
            return '';
    }
}

/** Part[] → CQ 字符串（供旧协议后端/测试使用；无法转换的段落降级为转义文本） */
export function renderCQ(parts: Part[], caps: PlatformCaps = {}, hooks: PlatformHooks = {}): string {
    if (!Array.isArray(parts)) return '';
    return renderSegments(parts, caps, hooks)
        .map(segment => {
            const cq = segmentToCQ(segment);
            if (cq) return cq;
            // 未知段类型：把 data 当文本保留（不静默丢）
            const fallback = segment.type === 'text' ? '' : JSON.stringify(segment.data || {});
            return escapeCQValue(fallback);
        })
        .join('');
}

/** 纯文本出口（论坛/非消息平台）：保内容、不改写，尽量保留可读信息 */
export function renderPlainText(parts: Part[]): string {
    if (!Array.isArray(parts)) return '';
    const out: string[] = [];
    for (const part of parts) {
        switch (part.type) {
            case 'text':
                out.push(part.text);
                break;
            case 'mention':
                out.push(part.all || part.id.toLowerCase() === 'all' ? '@全体成员' : `@${part.id}`);
                break;
            case 'quote':
                out.push(`[引用:${part.id}]`);
                break;
            case 'image':
                out.push(part.desc || part.ref);
                break;
            case 'avatar':
                out.push(`[头像:${part.uid}]`);
                break;
            case 'group_avatar':
                out.push(`[群头像:${part.gid}]`);
                break;
            case 'record':
                out.push(part.summary || '语音');
                break;
            case 'video':
                out.push(part.summary || '视频');
                break;
            case 'file':
                out.push(part.summary || '文件');
                break;
            case 'face':
                out.push(part.name);
                break;
            case 'poke':
                out.push(`[戳一戳:${part.id}]`);
                break;
            case 'forward':
                out.push(`[合并转发:${part.id}]`);
                break;
            case 'markdown':
                out.push(part.text);
                break;
            case 'resource':
                out.push(part.name || part.uri);
                break;
            case 'unknown':
                out.push(getDescriptorForPart(part).renderText(part));
                break;
        }
    }
    return out.join('');
}
