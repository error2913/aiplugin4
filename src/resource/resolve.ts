// 短 ID / 句柄解析（纯数据层）：把上下文里出现的特殊引用还原为原始字段。
//
// 供两个工具共用：
// - resolve_special_id（协议 API 前置解析，输出 JSON 原始字段）
// - resolve_context_ref（通用上下文引用解析，输出模型可读文本）
//
// 这里只做“引用 → 数据”，不依赖工具/会话；图片、媒体句柄、消息 ID 的解析口径以本文件为准。
import { transformMsgIdBack } from "../utils/message_id";
import { resolveSpecialResourceByType } from "../utils/special_id";

import Image from "./image";

export type SpecialResolveType = 'message' | 'image' | 'record' | 'video' | 'file';

export interface SpecialResolveSuccess {
    ok: true;
    type: SpecialResolveType;
    /** 调用方传入的原始引用（含标签时原样保留，便于回显） */
    ref: string;
    /** 解析后的短 ID / 句柄 */
    id: string;
    data: Record<string, unknown>;
}

export interface SpecialResolveFailure {
    ok: false;
    code: 'INVALID_ID' | 'NOT_FOUND';
    message: string;
}

export type SpecialResolveResult = SpecialResolveSuccess | SpecialResolveFailure;

/**
 * 剥掉标签包裹：[msg_id:xxx]/[quote:xxx]/[img:xxx] 单行形式，及
 * [record:xxx]摘要[/record]/[video:xxx]...[/video]/[file:xxx]...[/file] 闭合形式 → 取开标签参数 xxx；
 * 兼容 handle=xxx 旧形式。
 */
export function stripSpecialRef(raw: string): string {
    const trimmed = String(raw || '').trim();
    const m = /^\[(?:msg_id|quote|img|record|video|file):([^\]]+)\]/i.exec(trimmed);
    if (m) {
        const content = m[1].trim();
        // 闭合标签的 body 不是句柄：只取开标签冒号后的第一段（图片允许 :描述）
        return content;
    }
    if (/^handle=/i.test(trimmed)) return trimmed.replace(/^handle=/i, '').trim();
    return trimmed;
}

/** 解析短 ID/句柄为原始字段；失败返回可读错误（不抛异常） */
export function resolveSpecialRef(type: SpecialResolveType, raw: string): SpecialResolveResult {
    const ref = String(raw ?? '').trim();
    const id = stripSpecialRef(ref);
    if (!ref || !id) return { ok: false, code: 'INVALID_ID', message: `无法从 ${ref || '(空)'} 中提取短 ID/句柄` };

    switch (type) {
        case 'message': {
            const backId = transformMsgIdBack(id);
            if (backId === '') return { ok: false, code: 'INVALID_ID', message: `无法解析消息 ID：${ref}` };
            return { ok: true, type, ref, id, data: { message_id: String(backId) } };
        }
        case 'image': {
            const image = Image.resolveRef(id);
            if (!image) return { ok: false, code: 'NOT_FOUND', message: `未找到图片引用：${ref}` };
            let rawData: any = null;
            if (image.raw) {
                try { rawData = JSON.parse(image.raw); } catch { rawData = null; }
            }
            const rawFields = rawData && typeof rawData === 'object' ? rawData : {};
            return {
                ok: true,
                type,
                ref,
                id,
                data: {
                    image_id: image.imageId,
                    ...rawFields,
                    hosted_id: image.hostedId || undefined,
                    hosted_url: image.hostedUrl || undefined,
                    url: rawFields.url || image.url || undefined,
                    path: rawFields.path || image.path || undefined,
                    base64: image.base64 || undefined,
                    format: image.format || undefined,
                    description: image.description || undefined,
                },
            };
        }
        case 'record':
        case 'video':
        case 'file': {
            const res = resolveSpecialResourceByType(type, id);
            if (!res) {
                return { ok: false, code: 'NOT_FOUND', message: `未找到${type}句柄：${ref}（媒体句柄仅保存在内存，重启后失效）` };
            }
            return { ok: true, type, ref, id, data: { ...(res.data || {}) } };
        }
        default:
            return { ok: false, code: 'INVALID_ID', message: `未知类型：${String(type)}` };
    }
}
