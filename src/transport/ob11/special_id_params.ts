// 特殊 ID 参数归一化：把上下文里出现的短 ID 还原为协议端需要的原始值。
// - 消息 ID：上下文 [msg_id:base36]/[quote:base36] 或疑似 base36 短 ID → 十进制字符串（含 >2^53 精确值）
// - 图片：get_image 的 file 传 [img:图片ID:描述] 或 6 位图片 ID → 还原为接收时的原始 file/url/path
// - 语音：get_record 的 file 传 [voice:句柄] 或 6 位句柄 → 还原为登记时的原始 file/url/path
import Image from "../../resource/image";
import { resolveSpecialResourceByType } from "../../utils/special_id";
import { transformMsgIdBack } from "../../utils/utils";

/** 消息 ID 类参数：值可能是上下文 base36 短 ID，调用前还原为十进制（对所有 action 生效，纯十进制不会被误转） */
const MESSAGE_ID_PARAMS = new Set(["message_id", "message_seq"]);

/** 图片 ID 类 action：get_image 的 file 支持图片缓存文件名/URL/图片 ID */
const IMAGE_ID_ACTIONS = new Set(["get_image"]);

/** 语音类 action：get_record 的 file 支持语音缓存文件名/句柄 */
const RECORD_ID_ACTIONS = new Set(["get_record"]);

/** 6 位 base36 句柄/图片 ID（generateId 产物） */
const HANDLE_PATTERN = /^[0-9a-z]{6}$/i;

/** 提取 [quote:xxx]/[msg_id:xxx] 包裹的 base36 短消息 ID；不是该形式返回空串 */
function extractTaggedMsgId(value: string): string {
    const m = /^\[(?:quote|msg_id):([+-]?[0-9a-z]+)(?::[^\]]*)?\]$/i.exec(value);
    return m ? m[1] : "";
}

/** 疑似 base36 短消息 ID：字母数字串且至少含一个字母（纯十进制不会被误伤） */
function looksLikeBase36Id(value: string): boolean {
    return /^[+-]?[0-9a-z]+$/i.test(value) && /[a-z]/i.test(value);
}

/** 消息 ID 归一化：base36/带标签 → 十进制字符串；无法解析或非短 ID 原样返回 */
function normalizeMessageId(value: any): any {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    const inner = extractTaggedMsgId(trimmed) || (looksLikeBase36Id(trimmed) ? trimmed : "");
    if (!inner) return value;
    const backId = transformMsgIdBack(inner);
    if (backId === "") return value;
    return String(backId);
}

/** 尝试把图片 ID（含 [img:图片ID:描述] 包裹）解析为协议端可用的 file/url；失败原样返回 */
function resolveImageFile(value: any): any {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    let id = "";
    const tagMatch = /^\[img:([^\]]+)\]$/i.exec(trimmed);
    if (tagMatch) {
        const content = tagMatch[1];
        id = Image.get(content) ? content : (content.includes(":") && Image.get(content.split(":")[0]) ? content.split(":")[0] : "");
    } else if (HANDLE_PATTERN.test(trimmed) && Image.get(trimmed)) {
        id = trimmed;
    }
    if (!id) return value;
    const image = Image.get(id);
    if (!image) return value;
    let raw: any = null;
    if (image.raw) {
        try { raw = JSON.parse(image.raw); } catch { raw = null; }
    }
    const file = (raw && (raw.file || raw.url)) || image.url || image.path || "";
    return file || value;
}

/** 尝试把语音句柄（含 [voice:句柄] 包裹）解析为协议端可用的 file/url；失败原样返回 */
function resolveRecordFile(value: any): any {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    let handle = "";
    const tagMatch = /^\[voice:([^\]]+)\]$/i.exec(trimmed);
    if (tagMatch) handle = tagMatch[1];
    else if (HANDLE_PATTERN.test(trimmed)) handle = trimmed;
    else return value;
    const res = resolveSpecialResourceByType("voice", handle);
    if (!res) return value;
    const data = res.data || {};
    const file = data.file || data.url || data.path || "";
    return file || value;
}

/**
 * 归一化 action 参数里的特殊短 ID/句柄，返回新的 params（原对象不变）。
 * 未命中任何转换时返回原对象引用，避免无谓拷贝。
 */
export function normalizeSpecialIdParams(action: string, params: Record<string, any>): Record<string, any> {
    if (!params || typeof params !== "object" || Array.isArray(params)) return params;
    const out: Record<string, any> = { ...params };
    let changed = false;

    for (const key of Object.keys(out)) {
        if (MESSAGE_ID_PARAMS.has(key)) {
            const next = normalizeMessageId(out[key]);
            if (next !== out[key]) { out[key] = next; changed = true; }
        }
    }

    if (IMAGE_ID_ACTIONS.has(action) && out.file !== undefined) {
        const next = resolveImageFile(out.file);
        if (next !== out.file) { out.file = next; changed = true; }
    }
    if (RECORD_ID_ACTIONS.has(action) && out.file !== undefined) {
        const next = resolveRecordFile(out.file);
        if (next !== out.file) { out.file = next; changed = true; }
    }

    return changed ? out : params;
}
