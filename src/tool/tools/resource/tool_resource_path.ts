// 资源路径查询工具：把 list_resources 查到的资源 ID 解析为实际路径/URI。
// 不直接发送消息；mcp:// 默认只做结构解析，不触发 MCP 导出，避免产生短时副作用。
import Config from "../../../config/config";
import { getLocalImages } from "../../../resource/local_images";
import { getLocalAudios, getLocalFiles, getLocalVideos } from "../../../resource/local_paths";
import { resolveLocalPath } from "../../../utils/path";
import { parseMCPReference, resolveResourceReference } from "../../../utils/resource";
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
        const items = getLocalImages();
        const item = items.find(x => x.imageId === targetId);
        if (!item) return null;
        // 图片配置对象里保存的是已解析 path；原样配置值从 image 配置的 pathMap 取。
        const rawMap = (Config.image && (Config.image as any).LOCAL_IMAGE_PATH_MAP) || {};
        return { id: targetId, raw: Object.prototype.hasOwnProperty.call(rawMap, targetId) ? rawMap[targetId] : item.path };
    }
    const items = type === "audio"
        ? getLocalAudios()
        : type === "file"
            ? getLocalFiles()
            : getLocalVideos();
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
            description: "Look up the concrete path/URI of a configured local resource. First get the resource ID via list_resources, then call this tool for the resolved absolute path or URI of that resource." +
                "Useful when resource:ID must be handed to file reading/downloading/image recognition or other non-call_ob11_api sending scenarios." +
                "If the resource is mcp://, server and mcp_path are also returned; pass resolve_mcp=true to get a downloadable URL.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: [...RESOURCE_TYPES],
                        description: "Resource type"
                    },
                    id: {
                        type: "string",
                        description: "Resource ID/name; supports the resource:name or [img:image ID] prefix"
                    },
                    resolve_mcp: {
                        type: "boolean",
                        description: "Whether to resolve mcp:// resources to a downloadable URL; default false"
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
