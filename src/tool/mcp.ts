// MCP 客户端：把外部 MCP 服务器（Streamable HTTP / JSON-RPC）的工具注册为 AI 工具
// 多会话：按 AI 会话（session.sessionId）分桶维护 MCP 会话，同一 AI 会话的连续调用
// 复用同一 MCP 会话，保持服务端浏览器/登录状态；空闲或超限的会话按 LRU 回收。
import { ext } from "../config/config";
import Logger from "../logger";
import { parseJSONWithTrailingCommas } from "../utils/json";

import { buildContentParts, normalizeMCPResult } from "./mcp/result";
import { MCPCallResult } from "./mcp/types";
import Tool, { toolMap } from "./tool";

const log = Logger.withTag('mcp');

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

interface MCPServerSession {
    sessionId: string;
    lastUsedAt: number;
}

interface MCPServerState {
    server: MCPServer;
    /** 系统级会话：拉取工具列表与无会话上下文的内部桥接调用（callMCPTool）使用，空闲后回收、需要时重建 */
    defaultSessionId: string;
    defaultSessionUsedAt: number;
    tools: MCPToolDef[];
    toolsFetchedAt: number;
    /** 按 AI 会话分桶的 MCP 会话 */
    sessions: Map<string, MCPServerSession>;
}

const TOOLS_CACHE_TTL = 60 * 1000; // 工具列表缓存 60s
const DEFAULT_MAX_SESSIONS = 3; // 每服务器最大会话数默认 3（可配置「MCP每服务器最大会话数」）
const serverStates: { [name: string]: MCPServerState } = {};
const mcpToolKeys = new Map<string, string>(); // MCP 注册过的工具键 → 所属服务器名，仅清理这些键避免误删普通工具
let lastRefreshAt = 0; // 全量刷新节流：避免每条消息都重新同步工具列表

/** 服务器配置是否一致：url/token/headers 任一变化都视为新配置，需要重建会话并重新拉取工具列表 */
function sameServerConfig(a: MCPServer, b: MCPServer): boolean {
    if (a.url !== b.url || a.token !== b.token) return false;
    return JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {});
}

function sessionTTLMs(): number {
    const v = seal.ext.getIntConfig(ext, "MCP会话空闲回收分钟");
    return (Number.isFinite(v) && v > 0 ? v : 10) * 60 * 1000;
}

function maxSessionsPerServer(): number {
    const v = seal.ext.getIntConfig(ext, "MCP每服务器最大会话数");
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_SESSIONS;
}

/** 按名称取最新配置：始终实时解析当前配置（热加载后立即生效），不保留已移除服务器的旧会话 */
export function isMCPEnabled(): boolean {
    return seal.ext.getBoolConfig(ext, "是否启用MCP");
}

export function getMCPServerByName(name: string): MCPServer | null {
    // 只返回仍存在于配置中的服务器：服务器被移除后，即使工具列表尚未清理，调用也立即失败而非继续使用旧地址
    return getMCPServers().find(s => s.name === name) || null;
}

/** 归一化一个 MCP 服务器配置（兼容 Claude Desktop / Cursor .mcp.json 的 mcpServers 条目） */
function normalizeMCPServer(name: string, cfg: any): MCPServer | null {
    if (typeof cfg === 'string') {
        // 简写：{ "name": "http://..." }
        return { name, url: cfg, token: '', headers: {} };
    }
    if (!cfg || typeof cfg !== 'object') return null;

    // stdio 需要拉起子进程，海豹 goja 环境不支持，明确提示后跳过
    if (cfg.command) {
        log.warning(`MCP 服务器 ${name} 使用 stdio 传输，海豹运行环境无法拉起进程，已跳过；请改用 Streamable HTTP（type=http + url）`);
        return null;
    }
    const type = String(cfg.type || 'http').toLowerCase();
    if (type !== 'http' && type !== 'streamable-http') {
        log.warning(`MCP 服务器 ${name} 传输类型 ${type} 不受支持（当前仅支持 Streamable HTTP），已跳过`);
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
    if (!isMCPEnabled()) return [];

    const servers: MCPServer[] = [];
    for (const line of seal.ext.getTemplateConfig(ext, "MCP服务器配置").map(l => (l || '').trim()).filter(Boolean)) {
        try {
            const j = parseJSONWithTrailingCommas(line);
            // 标准 mcpServers 块：{"mcpServers":{"名称":{...}}}（Claude Desktop / Cursor .mcp.json）
            if (!j || typeof j !== 'object' || !j.mcpServers || typeof j.mcpServers !== 'object' || Array.isArray(j.mcpServers)) {
                log.error(`MCP服务器配置仅支持标准 mcpServers JSON 格式（{"mcpServers":{...}}），已忽略该行: ${line.slice(0, 120)}`);
                continue;
            }
            for (const [name, cfg] of Object.entries(j.mcpServers)) {
                const s = normalizeMCPServer(name, cfg);
                if (s) servers.push(s);
            }
        } catch (e) {
            log.exception(`MCP服务器配置解析失败（需要标准 mcpServers JSON 格式，兼容对象/数组尾逗号），内容: ${line}`, e);
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
            throw new Error(`MCP tools/list 失败: ${formatError(res.status, res.body)}`);
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

async function doCallTool(server: MCPServer, sessionId: string, name: string, args: any): Promise<MCPCallResult> {
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
    return {
        content: Array.isArray(result.content) ? result.content : undefined,
        structuredContent: result.structuredContent,
        isError: false
    };
}

function getOrCreateState(server: MCPServer): MCPServerState {
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
async function closeSessionIfBrowser(server: MCPServer, state: MCPServerState, sessionId: string): Promise<void> {
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
async function withSessionRetry<T>(server: MCPServer, key: string, fn: (sessionId: string) => Promise<T>): Promise<{ sessionId: string, value: T }> {
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
export async function callMCPTool(serverName: string, name: string, args: any = {}): Promise<MCPCallResult> {
    const server = getMCPServerByName(serverName);
    if (!server) throw new Error(`MCP 服务器 ${serverName} 未配置`);
    return callTool(server, '', name, args);
}
async function callTool(server: MCPServer, key: string, name: string, args: any): Promise<MCPCallResult> {
    const { value } = await withSessionRetry(server, key, sessionId => doCallTool(server, sessionId, name, args));
    return value;
}

/** 获取工具列表（TTL 缓存），并注册新出现的工具 */
async function syncTools(server: MCPServer, force = false): Promise<MCPToolDef[]> {
    const state = serverStates[server.name];
    if (!force && state && state.tools.length > 0
        && sameServerConfig(server, state.server)
        && Date.now() - state.toolsFetchedAt < TOOLS_CACHE_TTL) {
        return state.tools;
    }

    const { sessionId, value: tools } = await withSessionRetry(server, '', sessionId => listTools(server, sessionId));
    const s = getOrCreateState(server);
    s.server = server;
    s.defaultSessionId = sessionId;
    s.defaultSessionUsedAt = Date.now();
    s.tools = tools;
    s.toolsFetchedAt = Date.now();

    // 工具名称、描述和参数 schema 全部以 MCP tools/list 为准；服务器内工具删除后热加载清理。
    const liveKeys = new Set(tools.filter(t => !!t.name).map(t => t.name));
    for (const [key, owner] of mcpToolKeys) {
        if (owner === server.name && !liveKeys.has(key) && Object.prototype.hasOwnProperty.call(toolMap, key)) {
            log.info(`MCP 服务器 ${server.name} 不再提供工具 ${key}，清理`);
            delete toolMap[key];
            mcpToolKeys.delete(key);
        }
    }

    for (const t of tools) {
        if (!t.name) continue;
        const owner = mcpToolKeys.get(t.name);
        if ((owner && owner !== server.name) || (!owner && Object.prototype.hasOwnProperty.call(toolMap, t.name))) {
            log.info(`MCP 工具 ${t.name} 与已有工具同名，跳过（${server.name}.${t.name}）`);
            continue;
        }
        if (owner === server.name) delete toolMap[t.name];

        const schema = t.inputSchema && typeof t.inputSchema === 'object'
            ? t.inputSchema
            : { type: 'object', properties: {} };
        const tool = new Tool({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || 'MCP 工具',
                parameters: {
                    ...schema,
                    required: Array.isArray(schema.required) ? schema.required : []
                }
            }
        }, true);
        // 每次调用都重新读取当前服务器配置，支持配置热加载且不缓存旧凭据。
        // 按 AI 会话（session.sessionId）分桶：同一会话的连续浏览器操作复用同一 MCP 会话。
        tool.solve = async (_ctx, _msg, session, args) => {
            const current = getMCPServerByName(server.name);
            if (!current) return `MCP 服务器 ${server.name} 未配置`;
            const key = session && session.sessionId ? session.sessionId : '';
            const result = await callTool(current, key, t.name, args || {});
            const normalized = normalizeMCPResult(result);
            return { text: normalized.text, contentParts: buildContentParts(normalized) };

        };
        mcpToolKeys.set(t.name, server.name);
        log.debug(`已注册 MCP 工具 ${t.name}`);
    }
    return tools;
}

/**
 * 注册所有已配置 MCP 服务器的工具；可随时调用刷新（全量刷新按 TTL 节流）。
 * 已从配置中移除的服务器，其已注册工具会被同步清理，实现配置热加载。
 */
export async function registerMCPTools() {
    const now = Date.now();

    const servers = getMCPServers();
    const activeNames = new Set(servers.map(s => s.name));
    // 清理已从配置中移除的服务器的工具（仅限 MCP 注册过的键）。
    // 不参与 TTL 节流：删除服务器后下一条消息即清理，避免旧工具在缓存窗口内残留可调用
    for (const [key, serverName] of mcpToolKeys) {
        if (!activeNames.has(serverName) && Object.prototype.hasOwnProperty.call(toolMap, key)) {
            log.info(`MCP 服务器 ${serverName} 已从配置移除，清理工具 ${key}`);
            delete toolMap[key];
            mcpToolKeys.delete(key);
        }
    }
    // 清理 serverStates 中已移除的服务器；有 browser_close 的服务器先释放浏览器会话再删
    for (const name of Object.keys(serverStates)) {
        if (activeNames.has(name)) continue;
        const state = serverStates[name];
        for (const s of state.sessions.values()) {
            await closeSessionIfBrowser(state.server, state, s.sessionId);
        }
        await closeSessionIfBrowser(state.server, state, state.defaultSessionId);
        delete serverStates[name];
        log.info(`MCP 服务器 ${name} 已从配置移除，清理其会话`);
    }

    // 工具列表同步按 TTL 节流
    if (now - lastRefreshAt < TOOLS_CACHE_TTL) return;
    lastRefreshAt = now;

    for (const server of servers) {
        try {
            await syncTools(server);
        } catch (e) {
            log.exception(`MCP 服务器 ${server.name} 注册失败`, e);
        }
    }
}
