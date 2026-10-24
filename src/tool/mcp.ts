// MCP 工具注册层：把外部 MCP 服务器（Streamable HTTP / JSON-RPC）的工具注册为 AI 工具。
// 会话生命周期（initialize/tools.list/tools.call、分桶与 LRU 回收）在 ./mcp/client，
// 服务器配置/错误映射在 ./mcp/config；本文件只做「同步工具列表 → 注册到 toolMap → 清理失效工具」。
import Logger from "../logger";
import Image from "../resource/image";
import type { ImageSource } from "../resource/image_host";
import { matchesPlatform, platformOf } from "../utils/target_id";

import { callTool, closeSessionIfBrowser, getOrCreateState, listTools, serverStates, withSessionRetry } from "./mcp/client";
import { getLastRefreshAt, getMCPServerByName, getMCPServers, refreshMCPConfig, sameServerConfig, setLastRefreshAt, TOOLS_CACHE_TTL } from "./mcp/config";
import type { MCPServer, MCPToolDef } from "./mcp/config";
import { buildContentParts, normalizeMCPResult } from "./mcp/result";
import { MCPCallResult } from "./mcp/types";
import { toolMap } from "./registry";
import Tool from "./tool";

// 兼容旧引用：MCP 配置/错误映射已拆到 ./mcp/config（内部实现请直接引用叶子）
export { formatMcpError, getConfiguredMCPServers, getMCPServerByName, isMCPEnabled, refreshMCPConfig, resetMCPCacheForTest } from "./mcp/config";
export type { MCPServer } from "./mcp/config";

const log = Logger.withTag('mcp');

const mcpToolKeys = new Map<string, string>(); // MCP 注册过的工具键 → 所属服务器名，仅清理这些键避免误删普通工具

export async function callMCPTool(serverName: string, name: string, args: any = {}, sessionKey = ''): Promise<MCPCallResult> {
    const server = getMCPServerByName(serverName);
    if (!server) throw new Error(`MCP 服务器 ${serverName} 未配置`);
    return callTool(server, sessionKey, name, args);
}
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
        }, true, server.name, server.platforms);
        // 服务器配置为启动解析一次的缓存快照；按 AI 会话（session.sessionId）分桶：
        // 同一会话的连续浏览器操作复用同一 MCP 会话。
        tool.solve = async (ctx, _msg, session, args) => {
            const current = getMCPServerByName(server.name);
            if (!current) return `MCP 服务器 ${server.name} 未配置`;
            // 平台守卫：发现层之外再兜一层，避免绕过发现直接调用受限平台工具
            if (!matchesPlatform(current.platforms, platformOf(ctx))) {
                return `MCP 服务器 ${server.name} 的工具在当前平台不可用`;
            }
            const key = session && session.sessionId ? session.sessionId : '';
            const result = await callTool(current, key, t.name, args || {});
            // 工具调用来源（元数据）：平台/群/用户/会话/时间，供 MCP 图片入库时上报图床（不写标签）
            const source: ImageSource = {
                platform: platformOf(ctx),
                session_id: key,
                at: Date.now(),
            };
            if (ctx && ctx.group) source.group_id = String(ctx.group.groupId);
            if (ctx && ctx.player) source.user_id = String(ctx.player.userId);
            const normalized = normalizeMCPResult(result, { source, tool: t.name, server: server.name });
            // 图片引用生产者（image-host / imageRefs:true）：把 [img:<sha>] 规范化为 [img:h<sha>] 并注册虚拟图；
            // 其它服务器文本原样保留，不扩大提示注入面。
            if (current.imageRefs === true || current.name === 'image-host') {
                normalized.text = Image.normalizeToolText(normalized.text);
                // 本次工具调用所在的群/会话（元数据展示，不写成图片标签）；让 AI 知道图是在哪个群被拿到的
                if (/\[img[:：]/.test(normalized.text)) {
                    const where = ctx
                        ? (ctx.isPrivate ? '私聊' : (ctx.group ? `群${ctx.group.groupId}` : '当前会话'))
                        : '当前会话';
                    normalized.text += `\n（本次调用：${where} · 工具：${t.name}）`;
                }
            }
            return { text: normalized.text, contentParts: buildContentParts(normalized) };
        };
        mcpToolKeys.set(t.name, server.name);
        log.debug(`已注册 MCP 工具 ${t.name}`);
    }
    return tools;
}

/**
 * 注册所有已配置 MCP 服务器的工具（启动时注册一次；服务器列表为启动解析一次的缓存快照，
 * 修改 MCP 配置后需 .ai mcp refresh / 重载 JS 才生效）。工具列表同步仍按 TTL 节流，可发现服务器端新增的工具。
 * force=true 时绕过节流并强制重拉每个服务器的工具列表（refresh 使用）。
 */
export async function registerMCPTools(force = false) {
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

    // 工具列表同步按 TTL 节流；force 时跳过（refresh）
    if (!force && now - getLastRefreshAt() < TOOLS_CACHE_TTL) return;
    if (!force) setLastRefreshAt(now);

    for (const server of servers) {
        try {
            await syncTools(server, force);
        } catch (e) {
            log.exception(`MCP 服务器 ${server.name} 注册失败`, e);
        }
    }
}

/** 重新解析 MCP 服务器配置并强制重同步全部工具（.ai mcp refresh 使用） */
export async function refreshMCP(): Promise<{ servers: number; removed: number }> {
    const before = new Set(Object.keys(serverStates));
    refreshMCPConfig();
    await registerMCPTools(true);
    const after = new Set(Object.keys(serverStates));
    const removed = [...before].filter(n => !after.has(n)).length;
    return { servers: getMCPServers().length, removed };
}
