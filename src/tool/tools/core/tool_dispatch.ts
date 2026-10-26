// 按需加载调度工具：list_tools（分组列表）+ search_tools（发现工具，支持按 MCP 过滤）+ list_mcps（列出全部 MCP）+ call_tool（统一执行）
// 非核心工具不再全量注入函数 schema；AI 先搜索工具获得参数说明，再通过 call_tool 执行，
// 大幅降低每轮请求中工具定义占用的 token。工具按工具组分组（内置分类/MCP 服务器/技能/知识库），
// 且只对当前平台可用（platform 白名单）的工具可见/可调用。
import { Session } from "../../../session/session";
import { matchesPlatform, platformOf } from "../../../utils/target_id";
import { executeTool, type ToolFailure } from "../../executor";
import { getConfiguredMCPServers } from "../../mcp";
import { getTool, toolMap } from "../../registry";
import Tool from "../../tool";
import { ToolInfo } from "../../types";

/** call_tool 路径的错误文案 */
function callToolErrorText(toolName: string, failure?: ToolFailure): string {
    switch (failure?.code) {
        case 'not_found': return `Tool "${toolName}" does not exist. Call search_tools to see available tools and get parameter docs.`;
        case 'not_enabled': return `Tool "${toolName}" is not enabled in this session.`;
        case 'platform': {
            const tool = getTool(toolName);
            return `Tool "${toolName}" is not available on the current platform (source group "${Tool.groupLabel(tool?.group)}" has a platform restriction).`;
        }
        case 'session_type': return `Tool "${toolName}" is not available in this session type.`;
        case 'bad_args': return `call_tool failed to parse arguments: ${failure.message}`;
        case 'missing_required': return `Tool "${toolName}" is missing required parameter "${failure.param}".`;
        case 'invalid_arg': return `Tool "${toolName}" has an invalid argument: ${failure.message}`;
        default: return `Tool "${toolName}" failed: ${failure?.message ?? 'unknown error'}`;
    }
}

const MAX_SEARCH_RESULTS = 8; // search_tools 单次返回工具数上限
const MCP_PAGE_SIZE_LIMIT = 100;

export function registerDispatchTools() {

    // 工具列表：按工具组返回工具名称 + 一句话描述，不返回参数详情
    const listTool = new Tool({
        type: "function",
        function: {
            name: "list_tools",
            description: `List this session's available tools (current platform) with names and one-line descriptions, grouped by tool group (builtin categories such as Memory/Images/Subagents, MCP server names, Skills/Knowledge); parameter details are not included. Use search_tools to get a tool's parameter documentation.`,
            parameters: {
                type: "object",
                properties: {
                    page: {
                        type: "integer",
                        description: "Page number, starting at 1; default 1"
                    },
                    page_size: {
                        type: "integer",
                        description: "Page size; default 20, max 100"
                    },
                    query: {
                        type: "string",
                        description: "Filter by tool name or description keyword"
                    },
                    mcp: {
                        type: "string",
                        description: "Optional; only list tools from one source group or builtin category (e.g. MCP server name mcp-browser, category Memory/Images/Subagents)"
                    }
                },
                required: []
            }
        }
    });
    listTool.solve = async (ctx, _msg, session: Session, args) => {
        const { page = 1, page_size = 20, query = '', mcp = '' } = args || {};
        const platform = platformOf(ctx);
        let tools = Tool.getAvailableTools(session, platform)
            .sort((a, b) => a.function.name.localeCompare(b.function.name));
        const groupFilter = String(mcp || '').trim();
        if (groupFilter) tools = tools.filter(t => Tool.matchesGroupFilter(toolMap[t.function.name], groupFilter));
        const q = String(query || '').trim().toLowerCase();
        const filtered = q
            ? tools.filter(t =>
                t.function.name.toLowerCase().includes(q) ||
                t.function.description.toLowerCase().includes(q)
            )
            : tools;
        if (filtered.length === 0) {
            return groupFilter
                ? `No tools found in source group/category "${groupFilter}". Use list_mcps to see MCP servers, or call list_tools without a group filter.`
                : 'No tools are available in this session.';
        }
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), 100);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(filtered.length / size));
        const start = (current - 1) * size;
        const pageItems = filtered.slice(start, start + size);
        const lines = [`Available tools (${filtered.length} total)`];
        // 按组渲染（组头 + 组内工具，编号全局连续）；组头用「builtin · Category / MCP 服务器名 / Skills / Knowledge」
        const groups: { [group: string]: ToolInfo[] } = {};
        for (const t of pageItems) {
            const g = Tool.groupDisplay(toolMap[t.function.name]);
            (groups[g] = groups[g] || []).push(t);
        }
        let n = start;
        for (const g of Object.keys(groups).sort()) {
            lines.push(`## ${g}`);
            for (const t of groups[g]) {
                n += 1;
                const desc = String(t.function.description || '').replace(/\s+/g, ' ').trim();
                const shortDesc = desc.length > 240 ? desc.slice(0, 240) + '...' : desc;
                lines.push(`${n}. ${t.function.name}: ${shortDesc}`);
            }
        }
        lines.push(`Page ${current} of ${totalPages}. Use search_tools(name=...) for full parameter docs, or search_tools(query=...) to find a tool by capability.`);
        return lines.join('\n');
    };

    // 工具发现：返回匹配工具的完整 schema（含参数说明），供 call_tool 使用；支持按 MCP 服务器过滤
    const searchTool = new Tool({
        type: "function",
        function: {
            name: "search_tools",
            description: `View/search this session's available tools (current platform). With no arguments: returns the names of all available tools; with name: returns that tool's full parameter documentation; with query: searches tools by keyword and returns full parameter documentation; with mcp: searches only within that MCP server or builtin category (e.g. Memory/Images/Subagents). To call a tool that is not directly exposed in the function list, first get its parameter format from this tool, then execute it via call_tool.`,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search keyword matched against tool name or description; name takes precedence when both are given"
                    },
                    name: {
                        type: "string",
                        description: "Tool name; returns that tool's full parameter documentation"
                    },
                    mcp: {
                        type: "string",
                        description: "Optional; restrict the search to one source group or builtin category (MCP server name such as mcp-browser, category such as Memory/Images/Subagents); list_mcps lists MCP server names"
                    },
                    limit: {
                        type: "integer",
                        description: "Max number of tools returned by a query search; default 8, max 20"
                    }
                },
                required: []
            }
        }
    });
    searchTool.solve = async (ctx, _msg, session: Session, args) => {
        const { query = '', name = '', mcp = '', limit = MAX_SEARCH_RESULTS } = args || {};
        const platform = platformOf(ctx);
        let tools = Tool.getAvailableTools(session, platform);
        const groupFilter = String(mcp || '').trim();
        if (groupFilter) {
            tools = tools.filter(t => Tool.matchesGroupFilter(toolMap[t.function.name], groupFilter));
        }
        const notFoundInGroup = () => `No tools found in source group/category "${groupFilter}". Use list_mcps to see MCP servers, or call list_tools without a group filter.`;
        if (groupFilter && tools.length === 0) {
            return notFoundInGroup();
        }
        const toolName = String(name || '').trim();

        // 指定工具名：返回该工具的完整详情
        if (toolName) {
            const target = tools.find(t => t.function.name === toolName);
            if (!target) {
                if (groupFilter) return `Source group/category "${groupFilter}" has no tool named "${toolName}". Use list_mcps for MCP servers, or search_tools without arguments for all tool names.`;
                return `Tool "${toolName}" does not exist, is not enabled, or is not available on the current platform. Call search_tools without arguments to list all tool names.`;
            }
            return formatToolDetail(target, 1);
        }

        // 不传参数：返回全部工具名字列表（紧凑），详情按需查询
        if (!String(query || '').trim()) {
            if (tools.length === 0) {
                return groupFilter ? notFoundInGroup() : 'No tools are available in this session.';
            }
            return `Available tools (${tools.length} total):\n${tools.map((t, i) => `${i + 1}. ${t.function.name}`).join('\n')}\nNames and descriptions: call list_tools; parameter docs: search_tools(name="<tool>"); MCP servers: list_mcps`;
        }

        // 关键词搜索：分词匹配，返回匹配工具的完整详情
        const q = String(query || '').trim().toLowerCase();
        const keywords = q.split(/\s+/).filter(Boolean);
        const matched = keywords.length === 0
            ? tools
            : tools.map(t => ({ tool: t, hits: countKeywordHits(t, keywords) }))
                .filter(x => x.hits > 0)
                .sort((a, b) => b.hits - a.hits)
                .map(x => x.tool);
        const n = Math.max(1, Math.min(20, parseInt(limit, 10) || MAX_SEARCH_RESULTS));
        const list = matched.slice(0, n);
        if (list.length === 0) {
            return `No tools matched "${query}". Try list_tools to see available domains, or search a broader keyword.`;
        }
        return list.map((t, i) => formatToolDetail(t, i + 1)).join('\n\n') + `\n\nMatched ${matched.length} tools, showing ${list.length}.`;
    };

    // 列出全部 MCP 服务器及其工具（按 MCP 分组的能力入口）
    const listMcps = new Tool({
        type: "function",
        function: {
            name: "list_mcps",
            description: `List all MCP servers available on the current platform with their tool inventory (grouped by server, including session switch state), for choosing tool groups by capability; then use search_tools(mcp=server-name) to get tool parameters and call_tool to execute`,
            parameters: {
                type: "object",
                properties: {
                    page: {
                        type: "integer",
                        description: "Page number, starting at 1; default 1"
                    },
                    page_size: {
                        type: "integer",
                        description: "Page size; default 20, max 100"
                    },
                    query: {
                        type: "string",
                        description: "Filter by server name or tool name keyword"
                    }
                },
                required: []
            }
        }
    });
    listMcps.solve = async (ctx, _msg, session: Session, args) => {
        const { page = 1, page_size = 20, query = '' } = args || {};
        const platform = platformOf(ctx);
        const servers = getConfiguredMCPServers().filter(s => matchesPlatform(s.platforms, platform));
        if (servers.length === 0) return 'No MCP servers are available on the current platform (not configured, disabled, or platform mismatch; ask the bot owner to check the MCP server config).';
        const q = String(query || '').trim().toLowerCase();
        const rows: string[] = [];
        for (const s of servers) {
            const groupTools = Object.keys(toolMap)
                .filter(k => toolMap[k].group === s.name)
                .sort();
            // 会话开关状态：标注已开启/关闭
            const states = groupTools.map(name => ({ name, on: !!session?.toolState?.[name] }));
            const onCount = states.filter(x => x.on).length;
            const matchesQuery = !q || s.name.toLowerCase().includes(q) || states.some(x => x.name.toLowerCase().includes(q));
            if (!matchesQuery) continue;
            rows.push(`${s.name} (${groupTools.length} tools, ${onCount} on / ${groupTools.length - onCount} off${s.description ? `; ${s.description}` : ''})`);
            for (const st of states.slice(0, MCP_PAGE_SIZE_LIMIT)) {
                const tool = toolMap[st.name];
                const desc = String(tool?.toolInfo?.function?.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
                rows.push(`  ${st.name}${st.on ? '' : ' [off]'}${desc ? `: ${desc}` : ''}`);
            }
            if (states.length > MCP_PAGE_SIZE_LIMIT) rows.push(`  ... ${states.length} tools total`);
        }
        if (rows.length === 0) return 'No MCP servers matched the query.';
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), MCP_PAGE_SIZE_LIMIT);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(rows.length / size));
        const slice = rows.slice((current - 1) * size, current * size);
        const lines = [`MCP servers (${servers.length} available on this platform)`, ...slice];
        lines.push(`Page ${current} of ${totalPages}. Use search_tools(mcp=<server-name>) for parameter docs, then call_tool to execute.`);
        return lines.join('\n');
    };

    // 统一执行入口：调用任意已开启工具（含未注入 schema 的按需工具）
    const callTool = new Tool({
        type: "function",
        function: {
            name: "call_tool",
            description: `Execute the tool with the given name and return its result. Any enabled tool available on the current platform can be called, including tools not directly exposed in the function list; query search_tools first for the tool's parameter format.`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name of the tool to execute"
                    },
                    arguments: {
                        type: "object",
                        description: "Argument object passed to the tool; fields match the parameter documentation returned by search_tools"
                    }
                },
                required: ["name"]
            }
        }
    });
    callTool.sensitive = true; // 可触发任意工具（含发消息/封禁等敏感操作），调用会显著记录
    callTool.solve = async (ctx, msg, session: Session, args) => {
        const { name, arguments: rawArgs } = args || {};
        const toolName = String(name || '').trim();
        if (!toolName) return 'call_tool requires a tool name (name).';

        const execution = await executeTool(toolName, ctx, msg, session, { source: 'call_tool', args: rawArgs ?? {} });
        if (!execution.ok) return callToolErrorText(toolName, execution.failure);

        const content = execution.content ?? '';
        if (execution.contentParts && execution.contentParts.length > 0) {
            return { text: `${toolName} returned:\n${content}`, contentParts: execution.contentParts };
        }
        return `${toolName} returned:\n${content}`;
    };
}

/** 输出单个工具的完整详情（名称/描述/来源/参数 schema/调用方式）；来源统一用 groupDisplay 口径 */
function formatToolDetail(tool: ToolInfo, index: number): string {
    const source = Tool.groupDisplay(toolMap[tool.function.name]);
    return `${index}. ${tool.function.name} (source: ${source})\nDescription: ${tool.function.description}\nParameters (JSON Schema):\n${JSON.stringify(tool.function.parameters, null, 2)}\nCall it with call_tool, arguments: {"name": "${tool.function.name}", "arguments": {…}}`;
}

/** 统计工具被命中的关键词数（匹配名称或描述） */
function countKeywordHits(tool: ToolInfo, keywords: string[]): number {
    const haystack = `${tool.function.name} ${tool.function.description}`.toLowerCase();
    return keywords.reduce((acc, kw) => acc + (haystack.includes(kw) ? 1 : 0), 0);
}
