// 特殊 ID/句柄解析工具：把上下文里出现的短 ID 还原为原始字段。
// - message：上下文 [msg_id:base36]/[quote:base36] → 原始十进制消息 ID（含 >2^53 精确字符串）
// - image：上下文 [img:图片ID] → 接收时的原始段字段（file/file_unique/md5/url 等）与落盘 url/path/base64
// - voice/video/file：媒体消息里的 handle=句柄 → 登记时的原始字段（file/url/path/file_id/file_unique 等）
// 供 AI 对接 get_msg/delete_msg/get_image/get_record/文件下载等协议能力，避免把短 ID 原样外发。
import Image from "../../../resource/image";
import { resolveSpecialResourceByType } from "../../../utils/special_id";
import { transformMsgIdBack } from "../../../utils/utils";
import Tool from "../../tool";

const RESOLVE_TYPES = ["message", "image", "voice", "video", "file"] as const;
type ResolveType = typeof RESOLVE_TYPES[number];

function fail(code: string, message: string): string {
    return JSON.stringify({ ok: false, error: { code, message } });
}

/** 剥掉标签包裹：[msg_id:xxx]/[quote:xxx]/[img:xxx] 单行形式，及
 *  [voice:xxx]摘要[/voice]/[video:xxx]...[/video]/[file:xxx]...[/file] 闭合形式 → 取开标签参数 xxx；兼容 handle=xxx 旧形式 */
function stripTag(raw: string): string {
    const trimmed = String(raw || '').trim();
    const m = /^\[(?:msg_id|quote|img|voice|video|file):([^\]]+)\]/i.exec(trimmed);
    if (m) return m[1].trim();
    if (/^handle=/i.test(trimmed)) return trimmed.replace(/^handle=/i, '').trim();
    return trimmed;
}

export function registerResolveSpecialId() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "resolve_special_id",
            description: "解析上下文里出现的特殊短 ID/句柄，返回其原始字段，用于对接协议 API。\n" +
                "上下文中的消息 ID 是 base36 短 ID（[msg_id:xxx]/[quote:xxx]），图片是 6 位图片 ID（[img:xxx]），" +
                "语音/视频/文件消息是闭合标签（[voice:句柄]摘要[/voice]、[video:句柄]...[/video]、[file:句柄]...[/file]）。" +
                "需要把短 ID 交给 get_msg/delete_msg/get_image/get_record/文件下载等协议能力，或读取原始 " +
                "url/path/file/file_id/file_unique 等字段时，先调用本工具还原。",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: [...RESOLVE_TYPES],
                        description: "短 ID 类型：message=消息ID；image=图片ID；voice/video/file=媒体句柄"
                    },
                    id: {
                        type: "string",
                        description: "上下文里的短 ID 或句柄（如 [msg_id:3f]、[img:abc123]、[voice:abc123]摘要[/voice] 中的 abc123）"
                    }
                },
                required: ["type", "id"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const type = String((args && args.type) || "").trim().toLowerCase();
        const rawId = String((args && args.id) ?? "").trim();
        if (!RESOLVE_TYPES.includes(type as ResolveType)) {
            return fail("INVALID_PARAMS", `type 必须是 ${RESOLVE_TYPES.join("/")}`);
        }
        if (!rawId) return fail("INVALID_PARAMS", "id 不能为空");

        const id = stripTag(rawId);
        if (!id) return fail("INVALID_PARAMS", `无法从 ${rawId} 中提取短 ID`);

        switch (type as ResolveType) {
            case "message": {
                const backId = transformMsgIdBack(id);
                if (backId === "") return fail("INVALID_ID", `无法解析消息 ID：${rawId}`);
                return JSON.stringify({ ok: true, type, id: rawId, message_id: String(backId) });
            }
            case "image": {
                const image = Image.get(id) || (id.includes(":") ? Image.get(id.split(":")[0]) : null);
                if (!image) return fail("NOT_FOUND", `未找到图片 ID：${rawId}`);
                let raw: any = null;
                if (image.raw) {
                    try { raw = JSON.parse(image.raw); } catch { raw = null; }
                }
                return JSON.stringify({
                    ok: true,
                    type,
                    id: rawId,
                    image_id: image.imageId,
                    ...(raw || {}),
                    url: (raw && raw.url) || image.url || undefined,
                    path: (raw && raw.path) || image.path || undefined,
                    base64: image.base64 || undefined,
                    format: image.format || undefined,
                    description: image.description || undefined
                });
            }
            case "voice":
            case "video":
            case "file": {
                const res = resolveSpecialResourceByType(type as any, id);
                if (!res) {
                    return fail("NOT_FOUND", `未找到${type}句柄：${rawId}（媒体句柄仅保存在内存，重启后失效）`);
                }
                return JSON.stringify({ ok: true, type, id: rawId, ...(res.data || {}) });
            }
            default:
                return fail("INVALID_PARAMS", "未知类型");
        }
    };
}
