// OB11 运行时工具：只保留统一调用与转发文本解析，不保留按 action 的旧包装函数。
import Logger from "../logger";
import { callOb11ApiDirect, hasOb11Network } from "../transport/ob11/dispatcher";

import { parseCardToText, parseMusicToText } from "./string";

const log = Logger.withTag('ob11');

const MAX_FORWARD_DEPTH = 5;

export function netExists(): boolean {
    return hasOb11Network();
}

export async function callOb11Api(epId: string, action: string, params: Record<string, any> = {}): Promise<any | null> {
    return callOb11ApiDirect(epId, action, params);
}

async function getForwardMessage(epId: string, id: string): Promise<any[]> {
    const data = await callOb11Api(epId, "get_forward_msg", { id });
    if (!data) return [];
    if (Array.isArray(data.message)) return data.message;
    if (Array.isArray(data.messages)) return data.messages;
    return [];
}

async function forwardSegmentsToText(epId: string, message: any, depth: number, visited: Set<string>): Promise<string> {
    if (depth > MAX_FORWARD_DEPTH) return "[nested message too deep; truncated]";
    if (typeof message === "string") return message;
    if (!Array.isArray(message)) return "";

    let text = "";
    for (const seg of message) {
        if (!seg || typeof seg !== "object") continue;
        switch (seg.type) {
            case "text": text += (seg.data && seg.data.text) || ""; break;
            case "at": text += `@${(seg.data && (seg.data.qq || seg.data.user_id)) || ""} `; break;
            case "face": text += `[face:${(seg.data && seg.data.id) || ""}]`; break;
            case "image": text += "[image]"; break;
            case "record": text += "[record]voice[/record]"; break;
            case "video": text += "[video]video[/video]"; break;
            case "file": text += `[file]${(seg.data && (seg.data.name || seg.data.file || seg.data.file_id)) || "file"}[/file]`; break;
            case "json": text += parseCardToText(seg.data && (seg.data.data || seg.data.content)); break;
            case "music": text += parseMusicToText(seg.data || {}); break;
            case "node": text += await forwardMessagesToText(epId, [seg], depth + 1, visited); break;
            case "forward": {
                const fid = (seg.data && seg.data.id) || "";
                if (!fid || visited.has(String(fid))) {
                    text += "[forward reference loop; truncated]";
                    break;
                }
                visited.add(String(fid));
                text += await forwardMessagesToText(epId, await getForwardMessage(epId, String(fid)), depth + 1, visited);
                break;
            }
            default: text += `[${seg.type}]`;
        }
    }
    return text;
}

async function forwardMessagesToText(epId: string, messages: any[], depth = 0, visited: Set<string> = new Set()): Promise<string> {
    if (depth > MAX_FORWARD_DEPTH) return "[nested message too deep; truncated]";
    const lines: string[] = [];
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const nodeData = message.type === "node" ? message.data || {} : null;
        const sender = nodeData || message.sender || {};
        const name = sender.card || sender.nickname || `user ${sender.user_id || ""}`;
        const content = await forwardSegmentsToText(epId, nodeData ? nodeData.content : message.message, depth + 1, visited);
        lines.push(`${name}: ${content}`);
    }
    return lines.join("\n");
}

export async function expandForwardMessage(epId: string, id: string, depth = 0): Promise<string> {
    if (!netExists()) return "[ob11 network plugin not installed; cannot expand forward message]";
    try {
        return await forwardMessagesToText(epId, await getForwardMessage(epId, id), depth + 1);
    } catch (error) {
        log.exception('展开合并转发 ' + id + ' 失败', error);
        return "[forward expansion failed]";
    }
}
