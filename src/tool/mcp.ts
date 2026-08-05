// MCP 客户端：把外部 MCP 服务器（Streamable HTTP / JSON-RPC）的工具注册为 AI 工具
import { ext } from "../config/config";
import Logger from "../logger";

import Tool, { toolMap } from "./tool";

interface MCPServer {
    name: string;
    url: string;
    token: string;
}

interface MCPToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

function getMCPServers(): MCPServer[] {
    return seal.ext.getTemplateConfig(ext, "MCP服务器配置")
        .map(line => (line || '').trim())
        .filter(Boolean)
        .map(line => {
            const [name, url, token = ''] = line.split('|').map(s => s.trim());
            return { name, url, token };
        })
        .filter(s => s.name && s.url);
}

async function mcpRequest(url: string, token: string, payload: object, sessionId?: string): Promise<{ status: number, body: any, sessionId?: string }> {
    const headers: { [key: string]: string } = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const response = await fetch(url, {
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

async function initialize(server: MCPServer): Promise<string> {
    const res = await mcpRequest(server.url, server.token, {
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
        throw new Error(`MCP initialize 失败: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
    const sessionId = res.sessionId;
    await mcpRequest(server.url, server.token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    return sessionId;
}

async function listTools(server: MCPServer, sessionId: string): Promise<MCPToolDef[]> {
    const res = await mcpRequest(server.url, server.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
    const tools = res.body && res.body.result && res.body.result.tools;
    return Array.isArray(tools) ? tools : [];
}

async function callTool(server: MCPServer, sessionId: string, name: string, args: any): Promise<string> {
    const res = await mcpRequest(server.url, server.token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args }
    }, sessionId);
    const result = res.body && res.body.result;
    if (!result) {
        throw new Error(`MCP tools/call 失败: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
    const text = Array.isArray(result.content) ? result.content.map((b: any) => b.text || '').join('\n') : JSON.stringify(result);
    if (result.isError) {
        throw new Error(text || 'MCP 工具调用返回错误');
    }
    return text;
}

/**
 * 读取“MCP服务器配置”，初始化每个服务器并注册其工具（工具名为 服务器名_工具名）
 */
export async function registerMCPTools() {
    for (const server of getMCPServers()) {
        try {
            const sessionId = await initialize(server);
            const tools = await listTools(server, sessionId);
            for (const t of tools) {
                if (!t.name) continue;
                const toolName = `${server.name}_${t.name}`;
                if (Object.prototype.hasOwnProperty.call(toolMap, toolName)) continue;

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
                });
                tool.solve = async (_ctx, _msg, _session, args) => {
                    return await callTool(server, sessionId, t.name, args || {});
                };
                Logger.info(`已注册 MCP 工具 ${toolName}`);
            }
        } catch (e) {
            Logger.error(`MCP 服务器 ${server.name} 注册失败: ${e.message}`);
        }
    }
}
