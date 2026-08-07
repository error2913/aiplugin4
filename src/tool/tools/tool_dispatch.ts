// 按需加载调度工具：search_tools（发现工具）+ call_tool（统一执行）
// 非核心工具不再全量注入函数 schema；AI 先搜索工具获得参数说明，再通过 call_tool 执行，
// 大幅降低每轮请求中工具定义占用的 token
import Config from "../../config/config";
import Logger from "../../logger";
import { Session } from "../../session/session";
import { withTimeout } from "../../utils/utils";
import Tool, { toolMap } from "../tool";
import { ToolInfo } from "../types";

const MAX_SEARCH_RESULTS = 8; // search_tools 单次返回工具数上限

export function registerDispatchTools() {
    // 工具发现：返回匹配工具的完整 schema（含参数说明），供 call_tool 使用
    const searchTool = new Tool({
        type: "function",
        function: {
            name: "search_tools",
            description: `查看/搜索当前会话可用的工具。不传参数：返回全部可用工具的名字列表；指定 name：返回该工具的完整参数说明；指定 query：按关键词搜索匹配工具并返回完整参数说明。需要调用未直接在函数列表中提供的工具时，先通过本工具获取参数格式，再通过 call_tool 执行。`,
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
                    limit: {
                        type: "integer",
                        description: "query 搜索时最多返回的工具数，默认 8，最大 20"
                    }
                },
                required: []
            }
        }
    });
    searchTool.solve = async (_ctx, _msg, session: Session, args) => {
        const { query = '', name = '', limit = MAX_SEARCH_RESULTS } = args || {};
        const tools = Tool.getAvailableTools(session);
        const toolName = String(name || '').trim();

        // 指定工具名：返回该工具的完整详情
        if (toolName) {
            const target = tools.find(t => t.function.name === toolName);
            if (!target) return `工具 ${toolName} 不存在或未开启；可调用 search_tools（不传参数）查看全部工具名`;
            return formatToolDetail(target, 1);
        }

        // 不传参数：返回全部工具名字列表（紧凑），详情按需查询
        if (!String(query || '').trim()) {
            if (tools.length === 0) return '当前没有可用工具';
            return `可用工具（共 ${tools.length} 个）：\n${tools.map((t, i) => `${i + 1}. ${t.function.name}`).join('\n')}\n查看某个工具的详情：调用 search_tools 并指定 name=工具名`;
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

    // 统一执行入口：调用任意已开启工具（含未注入 schema 的按需工具）
    const callTool = new Tool({
        type: "function",
        function: {
            name: "call_tool",
            description: `执行指定名称的工具并返回结果。可调用当前会话所有已开启的工具，包括未直接在函数列表中提供的工具；工具参数格式请先用 search_tools 查询。`,
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

        let toolArgs = rawArgs || {};
        // 兼容提示词工程模式下 arguments 以 JSON 字符串传入
        if (typeof toolArgs === 'string') {
            try {
                toolArgs = JSON.parse(toolArgs);
            } catch (e) {
                return `call_tool 参数解析失败: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        const tool = toolMap[toolName];
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
            const content = await withTimeout(() => tool.solve(ctx, msg, session, toolArgs), Config.base.TIMEOUT);
            Logger.info(`[call_tool] ${toolName} 执行耗时 ${Date.now() - time}ms${tool.sensitive ? ' [敏感]' : ''}`);
            return `工具 ${toolName} 返回：\n${content}`;
        } catch (e) {
            Logger.error(`[call_tool] ${toolName} 执行失败: ${e instanceof Error ? e.message : String(e)}`);
            return `工具 ${toolName} 执行失败: ${e instanceof Error ? e.message : String(e)}`;
        }
    };
}

/** 输出单个工具的完整详情（名称/描述/参数 schema/调用方式） */
function formatToolDetail(tool: ToolInfo, index: number): string {
    return `${index}. ${tool.function.name}\n描述：${tool.function.description}\n参数（JSON Schema）：\n${JSON.stringify(tool.function.parameters, null, 2)}\n调用方式：使用 call_tool，参数为 {"name": "${tool.function.name}", "arguments": {…}}`;
}

/** 统计工具被命中的关键词数（匹配名称或描述） */
function countKeywordHits(tool: ToolInfo, keywords: string[]): number {
    const haystack = `${tool.function.name} ${tool.function.description}`.toLowerCase();
    return keywords.reduce((acc, kw) => acc + (haystack.includes(kw) ? 1 : 0), 0);
}
