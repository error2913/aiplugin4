// MCP 客户端会话层：JSON-RPC 请求、initialize/tools.list/tools.call、会话分桶与 LRU 回收、失效重试。
// 从 tool/mcp.ts 拆出——会话生命周期只依赖 ./mcp/config 与 logger，工具注册（registry）留在 mcp.ts；
// mcp.ts 仍导出 callMCPTool / registerMCPTools / refreshMCP，外部 API 不变。
import Logger from "../../logger";

import { formatMcpError, maxSessionsPerServer, MCPServer, MCPServerState, MCPToolDef, sameServerConfig, sessionTTLMs } from "./config";
import type { MCPCallResult } from "./types";

const log = Logger.withTag('mcp');
/** tools/call 携带的 AI 会话标识头：mcp-files-exec 等后端按它隔离默认工作区 */
const SESSION_KEY_HEADER = 'X-Aiplugin4-Session';
export const serverStates: { [name: string]: MCPServerState } = {};
async function mcpRequest(server: MCPServer, payload: object, sessionId?: string, sessionKey?: string): Promise<{ status: number, body: any, sessionId?: string }> {
    const headers: { [key: string]: string } = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...server.headers
    };
    if (server.token && !headers["Authorization"]) headers["Authorization"] = `Bearer ${server.token}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (sessionKey) headers[SESSION_KEY_HEADER] = encodeURIComponent(sessionKey);

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
        throw new Error(`MCP initialize 失败: ${formatMcpError(res.status, res.body)}`);
    }
    const sessionId = res.sessionId;
    await mcpRequest(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    return sessionId;
}

export async function listTools(server: MCPServer, sessionId: string): Promise<MCPToolDef[]> {
    const tools: MCPToolDef[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let requestId = 2;
    do {
        const res = await mcpRequest(server, {
            jsonrpc: '2.0',
            id: requestId++,
            method: 'tools/list',
            params: cursor ? { cursor } : {}
        }, sessionId);
        if (res.body && res.body.error) {
            throw new Error(`MCP tools/list 失败: ${formatMcpError(res.status, res.body)}`);
        }
        const result = res.body && res.body.result;
        if (result && Array.isArray(result.tools)) tools.push(...result.tools);
        const nextCursor = result && typeof result.nextCursor === 'string' && result.nextCursor
            ? result.nextCursor
            : undefined;
        if (!nextCursor || cursors.has(nextCursor)) break;
        cursors.add(nextCursor);
        cursor = nextCursor;
    } while (cursor);
    return tools;
}

async function doCallTool(server: MCPServer, sessionId: string, name: string, args: any, sessionKey?: string): Promise<MCPCallResult> {
    const res = await mcpRequest(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args }
    }, sessionId, sessionKey);
    const result = res.body && res.body.result;
    if (res.body && res.body.error) {
        throw new Error(`MCP 工具 ${name} 调用失败: ${formatMcpError(res.status, res.body)}`);
    }
    if (!result) {
        throw new Error(`MCP tools/call 失败: ${formatMcpError(res.status, res.body)}`);
    }
    const text = Array.isArray(result.content) ? result.content.map((b: any) => b.text || '').join('\n') : JSON.stringify(result);
    if (result.isError) {
        throw new Error(text || `MCP 工具 ${name} 返回错误`);
    }
    return {
        content: Array.isArray(result.content) ? result.content : undefined,
        structuredContent: result.structuredContent,
        isError: false
    };
}

export function getOrCreateState(server: MCPServer): MCPServerState {
    let state = serverStates[server.name];
    // 配置（url/token/headers）变化时重建：旧会话地址/凭据已失效，直接丢弃
    if (!state || !sameServerConfig(server, state.server)) {
        state = {
            server,
            defaultSessionId: '',
            defaultSessionUsedAt: 0,
            tools: [],
            toolsFetchedAt: 0,
            sessions: new Map()
        };
        serverStates[server.name] = state;
    }
    return state;
}

/** 若服务器提供 browser_close 工具，则调用它释放该会话的服务端浏览器 context（尽力而为，失败忽略） */
export async function closeSessionIfBrowser(server: MCPServer, state: MCPServerState, sessionId: string): Promise<void> {
    if (!sessionId) return;
    if (!state.tools.some(t => t.name === 'browser_close')) return;
    try {
        await doCallTool(server, sessionId, 'browser_close', {});
    } catch (e) {
        log.warning(`关闭 MCP 会话浏览器失败（可忽略）: ${server.name} ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** 空闲超时/超上限的会话按 LRU 回收；有 browser_close 的服务器先释放浏览器再删会话 */
async function evictSessions(server: MCPServer, state: MCPServerState): Promise<void> {
    const now = Date.now();
    const ttl = sessionTTLMs();
    const max = maxSessionsPerServer();

    for (const [key, s] of [...state.sessions]) {
        if (now - s.lastUsedAt <= ttl) continue;
        await closeSessionIfBrowser(server, state, s.sessionId);
        state.sessions.delete(key);
        log.info(`MCP 会话空闲回收: ${server.name} ${key}（空闲超过 ${Math.round(ttl / 60000)} 分钟）`);
    }

    if (state.sessions.size > max) {
        const sorted = [...state.sessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        const drop = sorted.slice(0, state.sessions.size - max);
        for (const [key, s] of drop) {
            await closeSessionIfBrowser(server, state, s.sessionId);
            state.sessions.delete(key);
            log.info(`MCP 会话超限回收: ${server.name} ${key}（每服务器上限 ${max}）`);
        }
    }

    if (state.defaultSessionId && now - state.defaultSessionUsedAt > ttl) {
        await closeSessionIfBrowser(server, state, state.defaultSessionId);
        state.defaultSessionId = '';
        log.info(`MCP 默认会话空闲回收: ${server.name}`);
    }
}

/**
 * 获取 MCP 会话：key 非空时按 AI 会话分桶（同会话复用，保持服务端状态），
 * key 为空时使用系统级默认会话（工具列表/内部桥接调用）。
 */
async function getSessionId(server: MCPServer, key: string, force = false): Promise<string> {
    const state = getOrCreateState(server);

    if (key) {
        const existing = state.sessions.get(key);
        if (!force && existing && existing.sessionId) {
            existing.lastUsedAt = Date.now();
            return existing.sessionId;
        }
        const sessionId = await initialize(server) || '';
        state.sessions.set(key, { sessionId, lastUsedAt: Date.now() });
        await evictSessions(server, state);
        return sessionId;
    }

    if (!force && state.defaultSessionId) {
        state.defaultSessionUsedAt = Date.now();
        return state.defaultSessionId;
    }
    const sessionId = await initialize(server) || '';
    state.defaultSessionId = sessionId;
    state.defaultSessionUsedAt = Date.now();
    return sessionId;
}

/** 判断 MCP 错误是否属于会话失效/服务器未初始化，需要重新 initialize */
function isSessionInvalidError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /会话不存在|已失效|session|未初始化|not initialized|Mcp-Session-Id|Server not initialized/i.test(msg);
}

/** 获取会话并执行请求；会话失效或服务器重启后未初始化时，重新 initialize 后重试一次 */
export async function withSessionRetry<T>(server: MCPServer, key: string, fn: (sessionId: string) => Promise<T>): Promise<{ sessionId: string, value: T }> {
    let sessionId = await getSessionId(server, key);
    try {
        return { sessionId, value: await fn(sessionId) };
    } catch (e) {
        if (!isSessionInvalidError(e)) throw e;
        log.warning(`MCP 会话失效，重新初始化后重试: ${server.name}`);
        sessionId = await getSessionId(server, key, true);
        return { sessionId, value: await fn(sessionId) };
    }
}

/** 供资源工具等内部桥接调用 MCP 工具，不依赖 MCP 工具是否已注册到 AI 工具列表。 */
export async function callTool(server: MCPServer, key: string, name: string, args: any): Promise<MCPCallResult> {
    const { value } = await withSessionRetry(server, key, sessionId => doCallTool(server, sessionId, name, args, key));
    return value;
}

/** 获取工具列表（TTL 缓存），并注册新出现的工具 */
