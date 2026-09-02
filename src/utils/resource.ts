// 资源引用解析：支持本地路径、file:// URI，以及 mcp://服务器/沙箱路径。
import { callMCPTool, getMCPServerByName } from "../tool/mcp";
import { MCPCallResult } from "../tool/mcp/types";

import { resolveLocalPath } from "./utils";

export interface ResolvedResource {
    path: string;
    name: string;
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch (_e) {
        return value;
    }
}

function basename(value: string): string {
    const clean = String(value || '').split(/[?#]/, 1)[0].replace(/[\\/]+$/, '');
    const match = /[^\\/]+$/.exec(clean);
    return match ? safeDecode(match[0]) : 'resource';
}

export function parseMCPReference(value: string, source?: string, serverName?: string): { server: string; path: string } | null {
    const raw = String(value || '').trim();
    if (/^mcp:\/\//i.test(raw)) {
        const match = /^mcp:\/\/([^\/]+)\/(.*)$/i.exec(raw);
        if (!match) throw new Error('MCP 文件路径格式应为 mcp://服务器名/沙箱相对路径');
        const server = safeDecode(match[1]).trim();
        const path = safeDecode(match[2]);
        if (!server || !path) throw new Error('MCP 文件路径格式应为 mcp://服务器名/沙箱相对路径');
        return { server, path };
    }
    if (String(source || '').toLowerCase() === 'mcp') {
        const server = String(serverName || 'mcp-files-exec').trim();
        const path = raw.replace(/^[/\\]+/, '');
        if (!server || !path) throw new Error('MCP 文件引用需要 server 和 path');
        return { server, path };
    }
    return null;
}

function makeMCPDownloadUrl(serverName: string, value: string): string {
    if (!/^\//.test(value)) return value;
    const server = getMCPServerByName(serverName);
    const origin = server && /^(https?:\/\/[^/]+)/i.exec(server.url);
    return origin ? `${origin[1]}${value}` : value;
}

function parseMCPResult(result: MCPCallResult): any {
    const structured = result && result.structuredContent;
    if (structured !== undefined && structured !== null) {
        if (typeof structured === 'string') {
            try { return JSON.parse(structured); } catch { return structured; }
        }
        return structured;
    }
    for (const block of result && result.content || []) {
        if (block && typeof block.text === 'string') {
            try { return JSON.parse(block.text); } catch { return block.text; }
        }
    }
    return null;
}

/** 将 MCP export_file 结果统一成可交给消息适配器的 URI/路径。 */
export async function resolveResourceReference(value: string, source?: string, serverName?: string, sessionKey?: string): Promise<ResolvedResource> {
    const mcp = parseMCPReference(value, source, serverName);
    if (!mcp) {
        const path = resolveLocalPath(value);
        return { path, name: basename(path) };
    }

    const result = parseMCPResult(await callMCPTool(mcp.server, 'export_file', { path: mcp.path }, sessionKey || ''));
    if (!result || typeof result !== 'object') throw new Error('MCP export_file 未返回文件信息');
    const downloadValue = String(result.downloadUrl || result.url || result.fileUri || result.uri || '').trim();
    const path = makeMCPDownloadUrl(mcp.server, downloadValue);
    if (!path) throw new Error('MCP export_file 未返回可发送的 downloadUrl/fileUri');
    const name = String(result.name || basename(mcp.path)).trim();
    return {
        path,
        name: name || basename(mcp.path)
    };
}
