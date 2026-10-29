// 特殊 ID/句柄解析工具：把上下文里出现的短 ID 还原为原始字段。
// - message：上下文 [msg_id:base36]/[quote:base36] → 原始十进制消息 ID（含 >2^53 精确字符串）
// - image：上下文 [img:图片ID] → 接收时的原始段字段（file/file_unique/md5/url 等）与落盘 url/path/base64
// - record/video/file：媒体消息里的 handle=句柄 → 登记时的原始字段（file/url/path/file_id/file_unique 等）
// 供 AI 对接 get_msg/delete_msg/get_image/get_record/文件下载等协议能力，避免把短 ID 原样外发。
// 实际解析在 src/resource/resolve.ts，与 resolve_context_ref 共用，避免两套口径。
import { resolveSpecialRef, SpecialResolveType } from "../../../resource/resolve";
import Tool from "../../tool";

const RESOLVE_TYPES = ["message", "image", "record", "video", "file"] as const;

function fail(code: string, message: string): string {
    return JSON.stringify({ ok: false, error: { code, message } });
}

export function registerResolveSpecialId() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "resolve_special_id",
            description: "Resolve special short IDs/handles found in the context and return their original fields, for calling protocol APIs.\n" +
                "Message IDs in the context are base36 short IDs ([msg_id:xxx]/[quote:xxx]); images are plugin image IDs or standard image references [img:<ref>] (including image-host h<sha256>, bare sha256, avatars); " +
                "voice/video/file messages are closing tags ([record:handle]summary[/record], [video:handle]...[/video], [file:handle]...[/file]). " +
                "When you need to pass a short ID to protocol capabilities such as get_msg/delete_msg/get_image/get_record/file download, or read the original " +
                "url/path/file/file_id/file_unique fields, resolve it with this tool first; image-host images additionally return hosted_id/hosted_url, have no protocol-side cached file, and should not use get_image again.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: [...RESOLVE_TYPES],
                        description: "Short ID type: message=message ID; image=image ID; record/video/file=media handle"
                    },
                    id: {
                        type: "string",
                        description: "Short ID or handle from the context (e.g. abc123 in [msg_id:3f], [img:abc123], or [record:abc123]summary[/record])"
                    }
                },
                required: ["type", "id"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const type = String((args && args.type) || "").trim().toLowerCase();
        const rawId = String((args && args.id) ?? "").trim();
        if (!RESOLVE_TYPES.includes(type as (typeof RESOLVE_TYPES)[number])) {
            return fail("INVALID_PARAMS", `type 必须是 ${RESOLVE_TYPES.join("/")}`);
        }
        if (!rawId) return fail("INVALID_PARAMS", "id 不能为空");

        const result = resolveSpecialRef(type as SpecialResolveType, rawId);
        if (result.ok === false) return fail(result.code, result.message);
        return JSON.stringify({ ok: true, type: result.type, id: result.ref, ...result.data });
    };
}
