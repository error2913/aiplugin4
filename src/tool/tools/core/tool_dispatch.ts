// 按需加载调度工具：list_tools（分组列表）+ search_tools（发现工具，支持按 MCP 过滤）+ list_mcps（列出全部 MCP）+ call_tool（统一执行）
// 非核心工具不再全量注入函数 schema；AI 先搜索工具获得参数说明，再通过 call_tool 执行，
// 大幅降低每轮请求中工具定义占用的 token。工具按工具组分组（内置分类/MCP 服务器/技能/知识库），
// 且只对当前平台可用（platform 白名单）的工具可见/可调用。
import Config from "../../../config/config";
import Logger from "../../../logger";
import { Session } from "../../../session/session";
import { matchesPlatform, platformOf } from "../../../utils/target_id";
import { StopError, withTimeout } from "../../../utils/utils";
import { getConfiguredMCPServers } from "../../mcp";
import Tool, { toolMap } from "../../tool";
import { ToolInfo } from "../../types";

const MAX_SEARCH_RESULTS = 8; // search_tools 单次返回工具数上限
const MCP_PAGE_SIZE_LIMIT = 100;

export function registerDispatchTools() {

    // 工具列表：按工具组返回工具名称 + 一句话描述，不返回参数详情
    const listTool = new Tool({
        type: "function",
        function: {
            name: "list_tools",
            description: `分页列出当前会话可用（当前平台）工具的名称与一句话描述，按工具组分组（内置分类如 记忆/图片/子代理、MCP 服务器名、技能、知识库）；不返回参数详情。需要获取某个工具的参数说明时使用 search_tools。`,
            parameters: {
                type: "object",
                properties: {
                    page: {
                        type: "integer",
                        description: "页码，从 1 开始，默认 1"
                    },
                    page_size: {
                        type: "integer",
                        description: "每页数量，默认 20，最大 100"
                    },
                    query: {
                        type: "string",
                        description: "按工具名称或描述关键词过滤"
                    },
                    mcp: {
                        type: "string",
                        description: "可选，只列出某个来源分组或内置分类下的工具（如 MCP 服务器名 mcp-browser、分类 记忆/图片/子代理）"
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
            return groupFilter ? `未找到来源分组/分类「${groupFilter}」下的工具；可用 list_mcps 查看 MCP 服务器，.ai tool 查看工具组` : '当前没有可用工具';
        }
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), 100);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(filtered.length / size));
        const start = (current - 1) * size;
        const pageItems = filtered.slice(start, start + size);
        const lines = [`可用工具（共 ${filtered.length} 个）`];
        // 按组渲染（组头 + 组内工具，编号全局连续）；组头用「内置·分类 / MCP 服务器名 / 技能 / 知识库」
        const groups: { [group: string]: ToolInfo[] } = {};
        for (const t of pageItems) {
            const g = Tool.groupDisplay(toolMap[t.function.name]);
            (groups[g] = groups[g] || []).push(t);
        }
        let n = start;
        for (const g of Object.keys(groups).sort()) {
            lines.push(`【${g}】`);
            for (const t of groups[g]) {
                n += 1;
                const desc = String(t.function.description || '').replace(/\s+/g, ' ').trim();
                const shortDesc = desc.length > 120 ? desc.slice(0, 120) + '...' : desc;
                lines.push(`${n}. ${t.function.name}：${shortDesc}`);
            }
        }
        lines.push(`当前第 ${current} 页，共 ${totalPages} 页；使用 search_tools 获取具体参数说明。`);
        return lines.join('\n');
    };

    // 工具发现：返回匹配工具的完整 schema（含参数说明），供 call_tool 使用；支持按 MCP 服务器过滤
    const searchTool = new Tool({
        type: "function",
        function: {
            name: "search_tools",
            description: `查看/搜索当前会话可用（当前平台）的工具。不传参数：返回全部可用工具的名字列表；指定 name：返回该工具的完整参数说明；指定 query：按关键词搜索匹配工具并返回完整参数说明；指定 mcp：只在该 MCP 服务器或内置分类（如 记忆/图片/子代理）内搜索。需要调用未直接在函数列表中提供的工具时，先通过本工具获取参数格式，再通过 call_tool 执行。`,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "搜索关键词，匹配工具名称或描述；与 name 同时给出时以 name 优先"
                    },
                    name: {
                        type: "string",
                        description: "指定工具名，返回该工具的完整参数说明"
                    },
                    mcp: {
                        type: "string",
                        description: "可选，限定在某个来源分组或内置分类内搜索工具（MCP 服务器名如 mcp-browser、分类如 记忆/图片/子代理）；可用 list_mcps 查看 MCP 服务器名"
                    },
                    limit: {
                        type: "integer",
                        description: "query 搜索时最多返回的工具数，默认 8，最大 20"
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
        const notFoundInGroup = () => `未找到来源分组/分类「${groupFilter}」下的工具；可用 list_mcps 查看 MCP 服务器，.ai tool 查看工具组`;
        if (groupFilter && tools.length === 0) {
            return notFoundInGroup();
        }
        const toolName = String(name || '').trim();

        // 指定工具名：返回该工具的完整详情
        if (toolName) {
            const target = tools.find(t => t.function.name === toolName);
            if (!target) {
                if (groupFilter) return `来源分组/分类「${groupFilter}」中没有工具 ${toolName}；可用 list_mcps 查看 MCP 服务器，search_tools（不传参数）查看全部工具名`;
                return `工具 ${toolName} 不存在、未开启或当前平台不可用；可调用 search_tools（不传参数）查看全部工具名`;
            }
            return formatToolDetail(target, 1);
        }

        // 不传参数：返回全部工具名字列表（紧凑），详情按需查询
        if (!String(query || '').trim()) {
            if (tools.length === 0) {
                return groupFilter ? `未找到来源分组/分类「${groupFilter}」下的工具；可用 list_mcps 查看 MCP 服务器，.ai tool 查看工具组` : '当前没有可用工具';
            }
            return `可用工具（共 ${tools.length} 个）：\n${tools.map((t, i) => `${i + 1}. ${t.function.name}`).join('\n')}\n查看工具名称与描述：调用 list_tools；查看某个工具的详情：调用 search_tools 并指定 name=工具名；查看 MCP 服务器：调用 list_mcps`;
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
            return `没有找到与「${query}」匹配的工具`;
        }
        return list.map((t, i) => formatToolDetail(t, i + 1)).join('\n\n') + `\n\n共匹配 ${matched.length} 个，已返回 ${list.length} 个。`;
    };

    // 列出全部 MCP 服务器及其工具（按 MCP 分组的能力入口）
    const listMcps = new Tool({
        type: "function",
        function: {
            name: "list_mcps",
            description: `列出当前平台可用的全部 MCP 服务器及其工具清单（按服务器分组，含会话开关状态），用于按能力组选择工具；随后可用 search_tools(mcp=服务器名) 获取工具参数、call_tool 执行`,
            parameters: {
                type: "object",
                properties: {
                    page: {
                        type: "integer",
                        description: "页码，从 1 开始，默认 1"
                    },
                    page_size: {
                        type: "integer",
                        description: "每页数量，默认 20，最大 100"
                    },
                    query: {
                        type: "string",
                        description: "按服务器名或工具名关键词过滤"
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
        if (servers.length === 0) return '当前没有可用的 MCP 服务器（未配置、未启用或平台不匹配；请管理员检查「MCP服务器配置」）';
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
            rows.push(`${s.name}（${groupTools.length} 个工具，开 ${onCount} 关 ${groupTools.length - onCount}）`);
            for (const st of states.slice(0, MCP_PAGE_SIZE_LIMIT)) {
                const tool = toolMap[st.name];
                const desc = String(tool?.toolInfo?.function?.description || '').replace(/\s+/g, ' ').trim().slice(0, 100);
                rows.push(`  ${st.name}${st.on ? '' : '[关]'}${desc ? `：${desc}` : ''}`);
            }
            if (states.length > MCP_PAGE_SIZE_LIMIT) rows.push(`  …共 ${states.length} 个工具`);
        }
        if (rows.length === 0) return '没有匹配的 MCP 服务器';
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), MCP_PAGE_SIZE_LIMIT);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(rows.length / size));
        const slice = rows.slice((current - 1) * size, current * size);
        const lines = [`MCP 服务器（共 ${servers.length} 台，当前平台可用）`, ...slice];
        lines.push(`当前第 ${current} 页，共 ${totalPages} 页；使用 search_tools(mcp=服务器名) 查看参数，call_tool 执行。`);
        return lines.join('\n');
    };

    // 统一执行入口：调用任意已开启工具（含未注入 schema 的按需工具）
    const callTool = new Tool({
        type: "function",
        function: {
            name: "call_tool",
            description: `执行指定名称的工具并返回结果。可调用当前会话所有已开启且当前平台可用的工具，包括未直接在函数列表中提供的工具；工具参数格式请先用 search_tools 查询。`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "要执行的工具名称"
                    },
                    arguments: {
                        type: "object",
                        description: "传给该工具的参数对象，字段与 search_tools 返回的参数说明一致"
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
        if (!toolName) return 'call_tool 缺少工具名 name';
        if (!Object.prototype.hasOwnProperty.call(toolMap, toolName)) {
            return `工具 ${toolName} 不存在，可先调用 search_tools 查看可用工具`;
        }
        if (!session.toolState?.[toolName]) {
            return `工具 ${toolName} 未开启，无法调用`;
        }
        const tool = toolMap[toolName];
        // 平台守卫：绕过发现层直接调用平台外工具时拒绝
        if (!Tool.isAllowedPlatform(tool, platformOf(ctx))) {
            return `工具 ${toolName} 在当前平台不可用（来源 ${Tool.groupLabel(tool.group)} 的平台限制）`;
        }

        let toolArgs = rawArgs || {};
        // 兼容提示词工程模式下 arguments 以 JSON 字符串传入
        if (typeof toolArgs === 'string') {
            try {
                toolArgs = JSON.parse(toolArgs);
            } catch (e) {
                return `call_tool 参数解析失败: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        if (tool.sessionType !== "any" && tool.sessionType !== session.sessionType) {
            return `工具 ${toolName} 不适用于当前会话类型`;
        }
        for (const key of (tool.toolInfo.function.parameters.required || [])) {
            if (!Object.prototype.hasOwnProperty.call(toolArgs, key)) {
                return `调用工具 ${toolName} 缺少必需参数 ${key}`;
            }
        }
        const validateError = Tool.validateArgs(tool, toolArgs);
        if (validateError) {
            return `调用工具 ${toolName} 参数错误: ${validateError}`;
        }

        const time = Date.now();
        try {
            const solved = await withTimeout(() => tool.solve(ctx, msg, session, toolArgs), Config.base.TIMEOUT, { stopEvent: session.stopEvent });
            Logger.info(`[call_tool] ${toolName} 执行耗时 ${Date.now() - time}ms${tool.sensitive ? ' [敏感]' : ''}`);
            const content = typeof solved === 'string' ? solved : solved.text;
            if (typeof solved !== 'string' && solved.contentParts && solved.contentParts.length > 0) {
                return { text: `工具 ${toolName} 返回：\n${content}`, contentParts: solved.contentParts };
            }
            return `工具 ${toolName} 返回：\n${content}`;
        } catch (e) {
            // stop 中断工具执行：向上抛出让工具链立即中止
            if (e instanceof StopError) throw e;
            Logger.error(`[call_tool] ${toolName} 执行失败: ${e instanceof Error ? e.message : String(e)}`);
            return `工具 ${toolName} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    };
}

/** 输出单个工具的完整详情（名称/描述/来源/参数 schema/调用方式）；来源统一用 groupDisplay 口径 */
function formatToolDetail(tool: ToolInfo, index: number): string {
    const source = Tool.groupDisplay(toolMap[tool.function.name]);
    return `${index}. ${tool.function.name}（来源：${source}）\n描述：${tool.function.description}\n参数（JSON Schema）：\n${JSON.stringify(tool.function.parameters, null, 2)}\n调用方式：使用 call_tool，参数为 {"name": "${tool.function.name}", "arguments": {…}}`;
}

/** 统计工具被命中的关键词数（匹配名称或描述） */
function countKeywordHits(tool: ToolInfo, keywords: string[]): number {
    const haystack = `${tool.function.name} ${tool.function.description}`.toLowerCase();
    return keywords.reduce((acc, kw) => acc + (haystack.includes(kw) ? 1 : 0), 0);
}
