// MCP 客户端：把外部 MCP 服务器（Streamable HTTP / JSON-RPC）的工具注册为 AI 工具
import { ext } from "../config/config";
import Logger from "../logger";

import Tool, { toolMap } from "./tool";

export interface MCPServer {
    name: string;
    url: string;
    token: string;
    headers: { [key: string]: string };
}

interface MCPToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

interface MCPServerState {
    server: MCPServer;
    sessionId: string;
    tools: MCPToolDef[];
    toolsFetchedAt: number;
}

const TOOLS_CACHE_TTL = 60 * 1000; // 工具列表缓存 60s
const serverStates: { [name: string]: MCPServerState } = {};
const mcpToolKeys = new Map<string, string>(); // MCP 注册过的工具键 → 所属服务器名，仅清理这些键避免误删普通工具
let lastRefreshAt = 0; // 全量刷新节流：避免每条消息都重新同步工具列表

/** 归一化一个 MCP 服务器配置（兼容 Claude Desktop / Cursor .mcp.json 的 mcpServers 条目） */
function normalizeMCPServer(name: string, cfg: any): MCPServer | null {
    if (typeof cfg === 'string') {
        // 简写：{ "name": "http://..." }
        return { name, url: cfg, token: '', headers: {} };
    }
    if (!cfg || typeof cfg !== 'object') return null;

    // stdio 需要拉起子进程，海豹 goja 环境不支持，明确提示后跳过
    if (cfg.command) {
        Logger.warning(`MCP 服务器 ${name} 使用 stdio 传输，海豹运行环境无法拉起进程，已跳过；请改用 Streamable HTTP（type=http + url）`);
        return null;
    }
    const type = String(cfg.type || 'http').toLowerCase();
    if (type !== 'http' && type !== 'streamable-http') {
        Logger.warning(`MCP 服务器 ${name} 传输类型 ${type} 不受支持（当前仅支持 Streamable HTTP），已跳过`);
        return null;
    }

    const headers: { [key: string]: string } = {};
    if (cfg.headers && typeof cfg.headers === 'object') {
        for (const [key, value] of Object.entries(cfg.headers)) {
            if (typeof value === 'string' && value) headers[key] = value;
        }
    }
    let token = String(cfg.token || '').trim();
    if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
    // 未单独给 token 时，从 headers 的 Authorization 里取，保持请求逻辑一致
    const auth = headers['Authorization'] || '';
    if (!token && auth.startsWith('Bearer ')) token = auth.slice(7).trim();

    return {
        name: String(cfg.name || name || '').trim(),
        url: String(cfg.url || '').trim(),
        token,
        headers
    };
}

function getMCPServers(): MCPServer[] {
    const servers: MCPServer[] = [];
    for (const line of seal.ext.getTemplateConfig(ext, "MCP服务器配置").map(l => (l || '').trim()).filter(Boolean)) {
        try {
            const j = JSON.parse(line);
            // 标准 mcpServers 块：{"mcpServers":{"名称":{...}}}（Claude Desktop / Cursor .mcp.json）
            if (j && typeof j === 'object' && j.mcpServers && typeof j.mcpServers === 'object') {
                for (const [name, cfg] of Object.entries(j.mcpServers)) {
                    const s = normalizeMCPServer(name, cfg);
                    if (s) servers.push(s);
                }
                continue;
            }
            // JSON 数组：[{name/url/type/headers...}]
            if (Array.isArray(j)) {
                for (const cfg of j) {
                    const s = normalizeMCPServer(String((cfg && (cfg.name || cfg.url)) || 'mcp'), cfg);
                    if (s) servers.push(s);
                }
                continue;
            }
            // 单服务器 JSON：{"name":"qq","type":"http","url":"http://...","headers":{...}}
            const s = normalizeMCPServer(String(j.name || j.url || ''), j);
            if (s) servers.push(s);
        } catch (e) {
            Logger.error(`MCP服务器配置解析失败（仅支持 JSON 格式）: ${e instanceof Error ? e.message : String(e)}，内容: ${line}`);
        }
    }
    return servers.filter(s => s.name && s.url);
}

async function mcpRequest(server: MCPServer, payload: object, sessionId?: string): Promise<{ status: number, body: any, sessionId?: string }> {
    const headers: { [key: string]: string } = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...server.headers
    };
    if (server.token && !headers["Authorization"]) headers["Authorization"] = `Bearer ${server.token}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const response = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });
    const text = await response.text();

    // Streamable HTTP 可能返回 SSE（data: {...}），也兼容纯 JSON
    let body: any = null;
    try {
        body = JSON.parse(text);
    } catch (_e) {
        const dataLine = text.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) body = JSON.parse(dataLine.slice(6));
    }
    return { status: response.status, body, sessionId: response.headers.get('mcp-session-id') || sessionId };
}

/** JSON-RPC 错误码 → 可读错误信息 */
function formatError(status: number, body: any): string {
    const err = body && body.error;
    if (err && typeof err === 'object') {
        const codeMsg: { [code: number]: string } = {
            [-32700]: '解析错误（请求不是合法 JSON）',
            [-32600]: '请求无效',
            [-32601]: '方法不存在',
            [-32602]: '参数无效',
            [-32603]: '服务器内部错误',
            [-32001]: '服务器未初始化',
            [-32002]: '会话不存在或已失效',
            [-32003]: '服务器繁忙'
        };
        const readable = codeMsg[err.code] || `错误码 ${err.code}`;
        return `${readable}${err.message ? `：${err.message}` : ''}`;
    }
    return `HTTP ${status} ${JSON.stringify(body)}`;
}

async function initialize(server: MCPServer): Promise<string | undefined> {
    const res = await mcpRequest(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'aiplugin4', version: '1.0' }
        }
    });
    if (!res.body || !res.body.result) {
        throw new Error(`MCP initialize 失败: ${formatError(res.status, res.body)}`);
    }
    const sessionId = res.sessionId;
    await mcpRequest(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    return sessionId;
}

async function listTools(server: MCPServer, sessionId: string): Promise<MCPToolDef[]> {
    const res = await mcpRequest(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
    if (res.body && res.body.error) {
        throw new Error(`MCP tools/list 失败: ${formatError(res.status, res.body)}`);
    }
    const tools = res.body && res.body.result && res.body.result.tools;
    return Array.isArray(tools) ? tools : [];
}

async function doCallTool(server: MCPServer, sessionId: string, name: string, args: any): Promise<string> {
    const res = await mcpRequest(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args }
    }, sessionId);
    const result = res.body && res.body.result;
    if (res.body && res.body.error) {
        throw new Error(`MCP 工具 ${name} 调用失败: ${formatError(res.status, res.body)}`);
    }
    if (!result) {
        throw new Error(`MCP tools/call 失败: ${formatError(res.status, res.body)}`);
    }
    const text = Array.isArray(result.content) ? result.content.map((b: any) => b.text || '').join('\n') : JSON.stringify(result);
    if (result.isError) {
        throw new Error(text || `MCP 工具 ${name} 返回错误`);
    }
    return text;
}

async function getSessionId(server: MCPServer, force = false): Promise<string> {
    const state = serverStates[server.name];
    if (!force && state && state.sessionId) return state.sessionId;
    const sessionId = await initialize(server) || '';
    serverStates[server.name] = { server, sessionId, tools: [], toolsFetchedAt: 0 };
    return sessionId;
}

async function callTool(server: MCPServer, name: string, args: any): Promise<string> {
    try {
        const sessionId = await getSessionId(server);
        return await doCallTool(server, sessionId, name, args);
    } catch (e) {
        // 会话失效时重新 initialize 并重试一次
        if (e instanceof Error && /会话不存在|已失效|session/i.test(e instanceof Error ? e.message : String(e))) {
            Logger.warning(`MCP 会话失效，重新初始化后重试: ${server.name}`);
            const sessionId = await getSessionId(server, true);
            return await doCallTool(server, sessionId, name, args);
        }
        throw e;
    }
}

/** 供内置工具直接调用某个 MCP 服务器的工具（如 web-read / md-html-render 后端） */
export async function callServerTool(server: MCPServer, toolName: string, args: any): Promise<string> {
    return await callTool(server, toolName, args || {});
}

/** 获取工具列表（TTL 缓存），并注册新出现的工具 */
async function syncTools(server: MCPServer, force = false): Promise<MCPToolDef[]> {
    const state = serverStates[server.name];
    if (!force && state && state.tools.length > 0 && Date.now() - state.toolsFetchedAt < TOOLS_CACHE_TTL) {
        return state.tools;
    }

    const sessionId = await getSessionId(server);
    const tools = await listTools(server, sessionId);
    serverStates[server.name] = { server, sessionId, tools, toolsFetchedAt: Date.now() };

    for (const t of tools) {
        if (!t.name) continue;
        const toolName = `${server.name}_${t.name}`;
        if (Object.prototype.hasOwnProperty.call(toolMap, toolName)) continue;
        mcpToolKeys.set(toolName, server.name);

        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        const tool = new Tool({
            type: 'function',
            function: {
                name: toolName,
                description: `${t.description || 'MCP 工具'}（MCP:${server.name}）`,
                parameters: {
                    ...schema,
                    required: Array.isArray(schema.required) ? schema.required : []
                }
            }
        }, true);
        tool.solve = async (_ctx, _msg, _session, args) => {
            return await callTool(server, t.name, args || {});
        };
        Logger.info(`已注册 MCP 工具 ${toolName}`);
    }
    return tools;
}

/**
 * 注册所有已配置 MCP 服务器的工具；可随时调用刷新（全量刷新按 TTL 节流）。
 * 已从配置中移除的服务器，其已注册工具会被同步清理，实现配置热加载。
 */
export async function registerMCPTools() {
    const now = Date.now();
    if (now - lastRefreshAt < TOOLS_CACHE_TTL) return;
    lastRefreshAt = now;

    const servers = getMCPServers();
    const activeNames = new Set(servers.map(s => s.name));
    // 清理已从配置中移除的服务器的工具（仅限 MCP 注册过的键）
    for (const [key, serverName] of mcpToolKeys) {
        if (!activeNames.has(serverName) && Object.prototype.hasOwnProperty.call(toolMap, key)) {
            Logger.info(`MCP 服务器 ${serverName} 已从配置移除，清理工具 ${key}`);
            delete toolMap[key];
            mcpToolKeys.delete(key);
        }
    }
    // 清理 serverStates 中已移除的服务器
    for (const name of Object.keys(serverStates)) {
        if (!activeNames.has(name)) delete serverStates[name];
    }

    for (const server of servers) {
        try {
            await syncTools(server);
        } catch (e) {
            Logger.error(`MCP 服务器 ${server.name} 注册失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
