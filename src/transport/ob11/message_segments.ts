import Config from "../../config/config";
import { FACE_MAP } from "../../config/static_config";
import { logger } from "../../logger";
import Image from "../../resource/image";
import { resolveResourceReference } from "../../utils/resource";
import { MessageSegment, parseSpecialTokens, stripInternalTags } from "../../utils/string";
import { getRawId, normalizeUserId } from "../../utils/target_id";
import { resolveLocalPath, transformMsgIdBack } from "../../utils/utils";

const log = logger.withTag('ob11-send');

/** 发送会话的最小结构（避免与 Session 形成循环依赖）：仅需能按 id 找到图片 */
export interface SendSessionLike {
    context: {
        findImage(ctx: seal.MsgContext, id: string): Promise<Image | null>;
    };
}

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

/**
 * 发送前把消息文本里的渲染标签解析成真正的消息段，避免内部标签/渲染标签被原样外发：
 * - 内部上下文标签 [from]/[msg_id]/[system]/[time] 由 parseSpecialTokens 直接剥离；
 * - [img:xxx] / [avatar:xxx] / [group_avatar:xxx] / [audio:xxx] 解析为图片/语音段；
 * - [at:xxx] / [poke:xxx] / [quote:xxx] / [face:xxx] 转换为对应消息段。
 * 数组消息只处理 text 段，结构化段（image/at 等）原样保留。
 */
export async function resolveSendMessage(
    ctx: seal.MsgContext,
    session: SendSessionLike,
    message: MessageSegment[] | string
): Promise<MessageSegment[] | string> {
    if (typeof message === "string") {
        return textToSegments(ctx, session, message);
    }
    if (!Array.isArray(message)) return message;
    const result: MessageSegment[] = [];
    for (const segment of message) {
        if (!segment || typeof segment !== "object") continue;
        if (segment.type === "text") {
            const sub = await textToSegments(ctx, session, String((segment.data && segment.data.text) ?? ""));
            if (sub) result.push(...sub);
        } else {
            result.push(segment);
        }
    }
    return result;
}

async function textToSegments(ctx: seal.MsgContext, session: SendSessionLike, text: string): Promise<MessageSegment[]> {
    const tokens = parseSpecialTokens(text);
    const out: MessageSegment[] = [];
    let pending = "";
    const flush = () => {
        if (pending) {
            out.push({ type: "text", data: { text: pending } });
            pending = "";
        }
    };
    for (const token of tokens) {
        switch (token.type) {
            case "text": {
                // 兜底剥离解析器未识别到的内部标签畸形写法
                pending += stripInternalTags(token.content);
                break;
            }
            case "img": {
                const id = token.content;
                // 兼容 [img:imageId:描述]：整体找不到时取首个冒号前作为图片 id
                const image = await session.context.findImage(ctx, id)
                    || (id.includes(":") ? await session.context.findImage(ctx, id.split(":")[0]) : null);
                if (image) {
                    flush();
                    out.push({ type: "image", data: { file: image.type === "base64" ? seal.base64ToImage(image.base64) : (image.url || image.path) } });
                } else {
                    log.warning(`发送消息时无法找到图片：${id}`);
                }
                break;
            }
            case "avatar": {
                const image = await session.context.findImage(ctx, `user_avatar:${token.content}`);
                if (image) {
                    flush();
                    out.push({ type: "image", data: { file: image.type === "base64" ? seal.base64ToImage(image.base64) : (image.url || image.path) } });
                } else log.warning(`发送消息时无法找到用户头像：${token.content}`);
                break;
            }
            case "group_avatar": {
                const image = await session.context.findImage(ctx, `group_avatar:${token.content}`);
                if (image) {
                    flush();
                    out.push({ type: "image", data: { file: image.type === "base64" ? seal.base64ToImage(image.base64) : (image.url || image.path) } });
                } else log.warning(`发送消息时无法找到群头像：${token.content}`);
                break;
            }
            case "audio": {
                const audios: { audioId: string, path: string }[] = Config.resource.LOCAL_AUDIOS || [];
                const audio = audios.find(a => a.audioId === token.content);
                if (audio) {
                    flush();
                    out.push({ type: "record", data: { file: resolveLocalPath(audio.path) } });
                } else log.warning(`发送消息时无法找到本地语音：${token.content}`);
                break;
            }
            case "at": {
                const userId = normalizeUserId(token.content);
                if (userId) {
                    flush();
                    out.push({ type: "at", data: { qq: getRawId(userId) } });
                } else log.warning(`发送消息时用户ID格式无效：${token.content}`);
                break;
            }
            case "poke": {
                const userId = normalizeUserId(token.content);
                if (userId) {
                    flush();
                    out.push({ type: "poke", data: { qq: getRawId(userId) } });
                } else log.warning(`发送消息时用户ID格式无效：${token.content}`);
                break;
            }
            case "quote": {
                const backId = transformMsgIdBack(token.content);
                if (Number.isFinite(backId)) {
                    flush();
                    out.push({ type: "reply", data: { id: String(backId) } });
                }
                break;
            }
            case "face": {
                const faceId = Object.keys(FACE_MAP).find(key => FACE_MAP[key] === token.content) || "";
                if (faceId) {
                    flush();
                    out.push({ type: "face", data: { id: faceId } });
                }
                break;
            }
            default: {
                // 未知标签：剥掉，不外发
                break;
            }
        }
    }
    flush();
    return out;
}
