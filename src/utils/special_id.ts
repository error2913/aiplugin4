// 特殊资源句柄：接收侧把语音/视频等原始段字段登记为短句柄并写入上下文文本（[voice:句柄]摘要[/voice] 等闭合标签），
// AI 通过 resolve_special_id(type=voice/video/file, id=句柄) 查询原始 url/path/file/file_unique 等字段。
import { generateId } from "./utils";

export type SpecialResourceType = "voice" | "video" | "file";

interface SpecialResource {
    type: SpecialResourceType;
    data: any;
}

const specialResourceMap = new Map<string, SpecialResource>();

/** 内存登记上限：超出后淘汰最早登记的句柄，避免长运行下无限增长 */
const MAX_SPECIAL_RESOURCES = 5000;

function newHandle(): string {
    for (let i = 0; i < 1000; i++) {
        const id = generateId();
        if (!specialResourceMap.has(id)) return id;
    }
    return generateId();
}

/** 登记一个特殊资源（语音/视频/文件），返回可写在上下文里的短句柄。 */
export function registerSpecialResource(type: SpecialResourceType, data: any): string {
    const handle = newHandle();
    specialResourceMap.set(handle, { type, data: data && typeof data === "object" ? data : {} });
    if (specialResourceMap.size > MAX_SPECIAL_RESOURCES) {
        const oldest = specialResourceMap.keys().next().value;
        if (oldest !== undefined) specialResourceMap.delete(oldest);
    }
    return handle;
}

/** 按句柄查询特殊资源；未登记返回 null。 */
export function resolveSpecialResource(handle: string): SpecialResource | null {
    const h = String(handle || "").trim();
    if (!h) return null;
    return specialResourceMap.get(h) || null;
}

/** 按类型 + 句柄查询特殊资源；类型不匹配或未登记返回 null。 */
export function resolveSpecialResourceByType(type: SpecialResourceType, handle: string): SpecialResource | null {
    const res = resolveSpecialResource(handle);
    return res && res.type === type ? res : null;
}
