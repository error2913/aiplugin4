// 资源路径查询工具：把 list_resources 查到的资源 ID 解析为实际路径/URI。
// 不直接发送消息；mcp:// 默认只做结构解析，不触发 MCP 导出，避免产生短时副作用。
import Config from "../../../config/config";
import { parseMCPReference, resolveResourceReference } from "../../../utils/resource";
import { resolveLocalPath } from "../../../utils/utils";
import Tool from "../../tool";

const RESOURCE_TYPES = ["image", "audio", "file", "video"] as const;
type ResourceType = typeof RESOURCE_TYPES[number];

function fail(code: string, message: string): string {
    return JSON.stringify({ ok: false, error: { code, message } });
}

function normalizeResourceId(type: string, id: string): string {
    let raw = String(id || "").trim();
    raw = raw.replace(/^resource:/i, "").trim();
    if (type === "image") {
        const tag = /^\[img:([^\]]+)\]/i.exec(raw);
        if (tag) {
            const content = tag[1].trim();
            raw = content.includes(":") ? content.slice(0, content.indexOf(":")) : content;
        }
    }
    return raw;
}

function getResourceRaw(type: ResourceType, id: string): { id: string; raw: string } | null {
    const targetId = normalizeResourceId(type, id);
    if (!targetId) return null;
    if (type === "image") {
        const items = Config.resource.LOCAL_IMAGES || [];
        const item = items.find(x => x.imageId === targetId);
        if (!item) return null;
        // 图片配置对象里保存的是已解析 path；原样配置值从 image 配置的 pathMap 取。
        const rawMap = (Config.image && (Config.image as any).LOCAL_IMAGE_PATH_MAP) || {};
        return { id: targetId, raw: Object.prototype.hasOwnProperty.call(rawMap, targetId) ? rawMap[targetId] : item.path };
    }
    const items = type === "audio"
        ? (Config.resource.LOCAL_AUDIOS || [])
        : type === "file"
            ? (Config.resource.LOCAL_FILES || [])
            : (Config.resource.LOCAL_VIDEOS || []);
    const item = items.find(x => (x as any)[`${type}Id`] === targetId);
    if (!item) return null;
    return { id: targetId, raw: item.path };
}

function detectScheme(value: string): string {
    if (/^mcp:\/\//i.test(value)) return "mcp";
    if (/^file:\/\//i.test(value)) return "file";
    if (/^https?:\/\//i.test(value)) return /^https:/i.test(value) ? "https" : "http";
    return "local";
}

export function registerResourcePathTool() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "get_resource_path",
            description: "查询已配置本地资源的具体路径/URI。先通过 list_resources 获取资源 ID，再调用本工具获取该资源解析后的绝对路径或 URI。" +
                "适用于需要把 resource:ID 交给文件读取/下载/识图等非 call_ob11_api 发送场景。" +
                "如果资源是 mcp://，会额外返回 server 和 mcp_path；需要下载 URL 时可传 resolve_mcp=true。",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: [...RESOURCE_TYPES],
                        description: "资源类型"
                    },
                    id: {
                        type: "string",
                        description: "资源 ID/名称，支持 resource:资源名 或 [img:图片ID] 前缀"
                    },
                    resolve_mcp: {
                        type: "boolean",
                        description: "mcp:// 资源是否解析为可下载 URL，默认 false"
                    }
                },
                required: ["type", "id"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const type = String((args && args.type) || "").trim().toLowerCase();
        if (!RESOURCE_TYPES.includes(type as ResourceType)) {
            return fail("INVALID_PARAMS", `type 必须是 ${RESOURCE_TYPES.join("/")}`);
        }
        const rawId = String((args && args.id) ?? "").trim();
        if (!rawId) return fail("INVALID_PARAMS", "id 不能为空");

        const entry = getResourceRaw(type as ResourceType, rawId);
        if (!entry) {
            return fail("NOT_FOUND", `未找到类型 ${type} 的资源：${normalizeResourceId(type, rawId)}，可先调用 list_resources(type=${type})`);
        }

        const raw = entry.raw;
        const scheme = detectScheme(raw);
        const result: any = {
            ok: true,
            type,
            id: entry.id,
            name: entry.id,
            raw,
            scheme,
            path: resolveLocalPath(raw)
        };

        if (scheme === "mcp") {
            try {
                const parsed = parseMCPReference(raw);
                if (parsed) {
                    result.server = parsed.server;
                    result.mcp_path = parsed.path;
                }
            } catch (error) {
                return fail("INVALID_MCP_REFERENCE", `MCP 路径格式错误：${error instanceof Error ? error.message : String(error)}`);
            }
            if (args && args.resolve_mcp === true) {
                try {
                    const ref = await resolveResourceReference(raw);
                    result.download_url = ref.path;
                } catch (error) {
                    return fail("MCP_EXPORT_FAILED", `MCP 导出失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }

        return JSON.stringify(result);
    };
}
