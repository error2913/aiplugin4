import Config from "../../config/config";
import { resolveResourceReference } from "../../utils/resource";
import { MessageSegment } from "../../utils/string";

function getResourcePath(id: string): string | null {
    const rawId = id.replace(/^resource:/i, "");
    const groups = [
        ...(Config.resource.LOCAL_IMAGES || []).map((item: any) => ({ id: item.imageId, path: item.path })),
        ...(Config.resource.LOCAL_AUDIOS || []).map((item: any) => ({ id: item.audioId, path: item.path })),
        ...(Config.resource.LOCAL_FILES || []).map((item: any) => ({ id: item.fileId, path: item.path })),
        ...(Config.resource.LOCAL_VIDEOS || []).map((item: any) => ({ id: item.videoId, path: item.path }))
    ];
    return groups.find(item => item.id === rawId)?.path || null;
}

/** 将消息/文件上传参数中的资源值解析成协议端可读取的路径或 URI。 */
export async function normalizeFileReference(value: any): Promise<any> {
    if (typeof value !== "string") return value;
    const configured = /^resource:/i.test(value) ? getResourcePath(value) : value;
    if (!configured) throw new Error(`未找到资源引用：${value}`);
    const resource = await resolveResourceReference(configured);
    return resource.path;
}

/** 解析资源引用，但不把消息段降级成普通文本。 */
export async function normalizeMessageSegments(message: MessageSegment[] | string): Promise<MessageSegment[] | string> {
    if (typeof message === "string") return message;
    if (!Array.isArray(message)) throw new Error("message 必须是字符串或消息段数组");

    const result: MessageSegment[] = [];
    for (const segment of message) {
        if (!segment || typeof segment !== "object" || typeof segment.type !== "string") {
            throw new Error("消息段格式无效");
        }
        const data: Record<string, any> = { ...(segment.data || {}) };
        if (["image", "record", "video", "file"].includes(segment.type) && data.file) {
            data.file = await normalizeFileReference(data.file);
        }
        if (segment.type === "node" && Array.isArray(data.content)) {
            data.content = await normalizeMessageSegments(data.content as MessageSegment[]);
        }
        result.push({ type: segment.type, data });
    }
    return result;
}

function escapeCQ(value: any): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/\[/g, "&#91;")
        .replace(/\]/g, "&#93;")
        .replace(/,/g, "&#44;");
}

function musicToCQ(data: Record<string, any>): string {
    const type = data.type || "custom";
    if (type === "qq" || type === "163") return `[CQ:music,type=${escapeCQ(type)},id=${escapeCQ(data.id)}]`;
    return `[CQ:music,type=custom,url=${escapeCQ(data.url)},audio=${escapeCQ(data.audio)},title=${escapeCQ(data.title)},content=${escapeCQ(data.content || "")},image=${escapeCQ(data.image || "")}]`;
}

/** 将 OB11 消息段编码成 SealDice 原生可以接收的消息字符串。 */
export function encodeNativeMessage(message: MessageSegment[] | string): string {
    if (typeof message === "string") return message;
    return message.map(segment => {
        const data = segment.data || {};
        switch (segment.type) {
            case "text": return String(data.text || "");
            case "face": return `[CQ:face,id=${escapeCQ(data.id)}]`;
            case "image": return `[CQ:image,file=${escapeCQ(data.file || data.url)}]`;
            case "record": return `[CQ:record,file=${escapeCQ(data.file || data.url)}${data.magic ? `,magic=${escapeCQ(data.magic)}` : ""}]`;
            case "video": return `[CQ:video,file=${escapeCQ(data.file || data.url)}]`;
            case "at": return `[CQ:at,qq=${escapeCQ(data.qq || data.user_id)}]`;
            case "reply": return `[CQ:reply,id=${escapeCQ(data.id)}]`;
            case "json": return `[CQ:json,data=${escapeCQ(data.data || data.content || "")}]`;
            case "markdown": return `[CQ:markdown,content=${escapeCQ(data.content || data.data || "")}]`;
            case "file": return `[CQ:file,file=${escapeCQ(data.file || data.url)}${data.name ? `,name=${escapeCQ(data.name)}` : ""}]`;
            case "music": return musicToCQ(data);
            case "poke": return `[CQ:poke,qq=${escapeCQ(data.qq || data.user_id)}]`;
            case "dice": return "[CQ:dice]";
            case "rps": return "[CQ:rps]";
            case "forward":
                if (data.id) return `[CQ:forward,id=${escapeCQ(data.id)}]`;
                throw new Error("native 后端无法凭空构造远程 forward，请使用 send_*_forward_msg 并安装 ob11 网络连接依赖");
            case "node":
                throw new Error("native 后端不支持直接发送 node 合并转发，请安装 ob11 网络连接依赖");
            default:
                throw new Error(`native 后端不支持消息段：${segment.type}`);
        }
    }).join("");
}
