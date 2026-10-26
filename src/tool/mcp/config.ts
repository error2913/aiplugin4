// MCP 配置与错误映射（叶子）：服务器配置解析/缓存、会话参数、错误信息格式化。
// 从 tool/mcp.ts 拆出——配置解析与客户端会话生命周期解耦；mcp.ts 保留 re-export，外部 import 零改动。
import Config, { ext } from "../../config/config";
import { McpServerEntry } from "../../config/domain/types";

import type { MCPToolAnnotations } from "./types";
export type MCPServer = McpServerEntry;

export interface MCPToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
    /** tools/list 的 annotations（安全分组元数据，不是提示词内容） */
    annotations?: MCPToolAnnotations;
}

export interface MCPServerSession {
    sessionId: string;
    lastUsedAt: number;
}

export interface MCPServerState {
    server: MCPServer;
    /** 系统级会话：拉取工具列表与无会话上下文的内部桥接调用（callMCPTool）使用，空闲后回收、需要时重建 */
    defaultSessionId: string;
    defaultSessionUsedAt: number;
    tools: MCPToolDef[];
    toolsFetchedAt: number;
    /** initialize 返回的服务器 instructions（运行时数据；仅 exposeInstructions=true 时进提示词） */
    instructions?: string;
    /** initialize 返回的 serverInfo.title（能力地图用途来源之一；服务器运行时数据） */
    serverTitle?: string;
    /** 按 AI 会话分桶的 MCP 会话 */
    sessions: Map<string, MCPServerSession>;
}

export const TOOLS_CACHE_TTL = 60 * 1000; // 工具列表缓存 60s
const DEFAULT_MAX_SESSIONS = 3; // 每服务器最大会话数默认 3（可配置「MCP每服务器最大会话数」）

let lastRefreshAt = 0; // 全量刷新节流：避免每条消息都重新同步工具列表（注册器经 get/set 访问）

/** 服务器配置是否一致：url/token/headers 任一变化都视为新配置，需要重建会话并重新拉取工具列表 */
export function sameServerConfig(a: MCPServer, b: MCPServer): boolean {
    if (a.url !== b.url || a.token !== b.token) return false;
    return JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {});
}

export function sessionTTLMs(): number {
    const v = seal.ext.getIntConfig(ext, "MCP会话空闲回收分钟");
    return (Number.isFinite(v) && v > 0 ? v : 10) * 60 * 1000;
}

export function maxSessionsPerServer(): number {
    const v = seal.ext.getIntConfig(ext, "MCP每服务器最大会话数");
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_SESSIONS;
}

// MCP 服务器配置属于启动解析一次、重载 JS 才生效的复杂配置：模块级缓存
let mcpEnabledCache: boolean | null = null;
let mcpServersCache: MCPServer[] | null = null;

/**
 * MCP 总开关：默认关闭，避免没配 MCP / 没装后端时在启动或对话里报错。
 * 开启后才会解析并连接「MCP服务器」里的服务器。
 */
export function isMCPEnabled(): boolean {
    if (mcpEnabledCache === null) mcpEnabledCache = seal.ext.getBoolConfig(ext, "是否启用MCP");
    return mcpEnabledCache;
}

export function getMCPServerByName(name: string): MCPServer | null {
    // 服务器列表为启动解析一次的缓存快照：修改配置后需重载 JS 才生效
    return getMCPServers().find(s => s.name === name) || null;
}

export function getMCPServers(): MCPServer[] {
    if (mcpServersCache) return mcpServersCache;
    if (!isMCPEnabled()) {
        mcpServersCache = [];
        return mcpServersCache;
    }

    // 解析失败由 config 层回退为空并记日志
    const servers = Config.mcp.MCP_SERVERS
        .map(s => ({ ...s, platforms: [...s.platforms], headers: { ...s.headers } }))
        .filter(s => s.name && s.url);
    mcpServersCache = servers;
    return mcpServersCache;
}

/** 返回全部已解析的 MCP 服务器快照（供 list_mcps / .ai mcp list 使用） */
export function getConfiguredMCPServers(): MCPServer[] {
    return getMCPServers();
}

/** 清空服务器缓存并重读配置（.ai mcp refresh 使用，随后强制重同步工具） */
export function refreshMCPConfig(): void {
    mcpEnabledCache = null;
    mcpServersCache = null;
    Config.invalidate('mcp');
}

/** 测试用：复位模块级缓存 */
export function resetMCPCacheForTest(): void {
    mcpEnabledCache = null;
    mcpServersCache = null;
    lastRefreshAt = 0;
    Config.invalidate('mcp');
}

/** 把 MCP HTTP 状态 + JSON-RPC 错误转成可读信息；401/403 优先按鉴权失败提示 */
export function formatMcpError(status: number, body: any): string {
    const err = body && body.error;
    if (status === 401 || status === 403) {
        const detail = err && typeof err === 'object' && err.message ? `：${err.message}` : '';
        return `鉴权失败（HTTP ${status}）${detail}；请检查该 MCP 服务器的 Authorization / token 是否与后端一致`;
    }
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


/** 供工具注册器读写刷新节流时间（配置模块不感知注册器实现） */
export function getLastRefreshAt(): number {
    return lastRefreshAt;
}

export function setLastRefreshAt(value: number): void {
    lastRefreshAt = value;
}
