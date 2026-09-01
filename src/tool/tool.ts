// 工具系统：Tool 注册表、工具调用（含扩展指令/提示词工程）与注册
import Config from "../config/config"
import Logger from "../logger"
import { TOOLS_PROMPT_TEMPLATE } from "../prompt/templates"
import { Session } from "../session/session";
import { SessionType } from "../session/types";
import { fixJsonString } from "../utils/string";
import { StopError, withTimeout } from "../utils/utils";

import { registerMCPTools } from "./mcp";
import { registerSkills } from "./skills";
import { registerTools } from "./tools/init";
import { ToolCall, ToolCallResult, ToolInfo, ToolInfoObject, ToolSolveContent } from "./types";

const log = Logger.withTag('tool');

export const toolMap: { [key: string]: Tool } = {};

export type ToolName = string;
export type ToolState = { [key: string]: boolean };

// 核心常驻工具：始终注入函数 schema，保证基本对话能力与“发现/执行”入口；
// 其余工具按需加载：AI 先用 search_tools 查找工具，再用 call_tool 执行，避免全量工具定义浪费 token
export const CORE_TOOL_NAMES: string[] = [
    'list_tools', // 工具列表（名称+描述）
    'search_tools', // 按需发现工具（返回完整参数说明）
    'call_tool',    // 统一执行入口（调用任意已开启工具）
    'use_skill',    // 技能调用
    'call_ob11_api', // 唯一 OB11 API 调用入口
    'run_ext_command',  // 扩展指令调用
    'run_core_command' // 核心指令调用
];

/** 原生 function calling 模式下只向 API 暴露的引导工具 */
export const NATIVE_TOOL_NAMES: string[] = ['list_tools', 'search_tools', 'call_tool'];

/** 提示词工程模式下需要完整参数说明的元工具 */
export const META_TOOL_NAMES: string[] = [
    'list_tools',
    'search_tools',
    'call_tool',
    'skill_list',
    'use_skill',
    'knowledge_list',
    'knowledge_docs',
    'knowledge_search',
    'knowledge_read'
];

const ON_DEMAND_PROMPT_LIMIT = 20;

function flattenText(text: string, maxLength: number): string {
    const flattened = String(text || '').replace(/\s+/g, ' ').trim();
    return flattened.length > maxLength ? flattened.slice(0, maxLength) + '...' : flattened;
}

function formatParameterText(parameters: ToolInfoObject): string {
    const properties = parameters && parameters.properties ? parameters.properties : {};
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    const lines = Object.keys(properties).map(key => {
        const prop = properties[key];
        const type = prop && typeof prop.type === 'string' ? prop.type : 'string';
        const isRequired = required.indexOf(key) !== -1;
        const desc = prop && typeof prop.description === 'string' ? flattenText(prop.description, 80) : '';
        return `${key}:${type}(${isRequired ? '必填' : '可选'})${desc ? ` - ${desc}` : ''}`;
    });
    return lines.join('\n');
}

export default class Tool {
    toolInfo: ToolInfo;
    sessionType: 'any' | SessionType; // 可使用函数的会话类型
    callBack: boolean; // 是否回调智能体
    sensitive: boolean; // 敏感工具（发送消息/封禁/改名等），调用会显著记录
    solve: (ctx: seal.MsgContext, msg: seal.Message, session: Session, args: { [key: string]: any }) => Promise<string | ToolSolveContent>;

    constructor(info: ToolInfo, sensitive = false) {
        this.toolInfo = info;
        this.sensitive = sensitive;
        this.sessionType = "any";
        this.callBack = true;
        this.solve = async (_, __, ___, ____) => "函数未实现";

        toolMap[info.function.name] = this;
    }

    /** 清空工具注册表（用于测试/热重载） */
    static reset() {
        for (const key of Object.keys(toolMap)) delete toolMap[key];
    }

    static registerTool() {
        registerTools();
        registerSkills();
        registerMCPTools().catch(e => log.exception('注册MCP工具失败', e));
    }



    static async handleToolCall(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_call: ToolCall): Promise<{ result: ToolCallResult, callBack: boolean }> {
        const name = tool_call.function.name;
        if (!Object.prototype.hasOwnProperty.call(toolMap, name)) {
            log.warning(`调用函数失败:未注册的函数:${name}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:未注册的函数:${name}` }, callBack: true };
        }
        if (!session.toolState?.[name]) {
            log.warning(`调用函数失败:未经许可的函数:${name}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:未经许可的函数:${name}` }, callBack: true };
        }

        const tool = toolMap[name];
        const msgType = msg.messageType === 'private' ? 'user' : 'group';
        if (tool.sessionType !== "any" && tool.sessionType !== msgType) {
            log.warning(`调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}`);
            return { result: { tool_call_id: tool_call.id, content: `调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}` }, callBack: true };
        }

        let args = null;
        try {
            args = JSON.parse(tool_call.function.arguments);
        } catch (e) {
            const fixedStr = fixJsonString(tool_call.function.arguments);
            if (fixedStr === '') {
                log.exception(`调用函数 (${name}:${tool_call.function.arguments}) 失败`, e);
                return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e instanceof Error ? e.message : String(e)}` }, callBack: true };
            }
            try {
                args = JSON.parse(fixedStr);
            } catch (e) {
                log.exception(`调用函数 (${name}:${tool_call.function.arguments}) 失败`, e);
                return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e instanceof Error ? e.message : String(e)}` }, callBack: true };
            }

        }

        try {
            if (args !== null && typeof args !== 'object') {
                log.warning(`调用函数失败:arguement不是一个object`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数失败:arguement不是一个object` }, callBack: true };
            }
            for (const key of (tool.toolInfo.function.parameters.required || [])) {
                if (!Object.prototype.hasOwnProperty.call(args, key)) {
                    log.warning(`调用函数失败:缺少必需参数 ${key}`);
                    return { result: { tool_call_id: tool_call.id, content: `调用函数失败:缺少必需参数 ${key}` }, callBack: true };
                }
            }

            const validateError = Tool.validateArgs(tool, args);
            if (validateError) {
                log.warning(`调用函数失败:${validateError}`);
                return { result: { tool_call_id: tool_call.id, content: `调用函数失败:${validateError}` }, callBack: true };
            }

            const { TIMEOUT } = Config.base;
            const time = Date.now();
            const solved = await withTimeout(() => tool.solve(ctx, msg, session, args), TIMEOUT, { stopEvent: session.stopEvent });
            const content = typeof solved === 'string' ? solved : solved.text;
            log.info(`${name} 执行耗时 ${Date.now() - time}ms${tool.sensitive ? ' [敏感]' : ''}`);
            const result: ToolCallResult = { tool_call_id: tool_call.id, content };
            if (typeof solved !== 'string' && solved.contentParts && solved.contentParts.length > 0) {
                result.contentParts = solved.contentParts;
            }
            if (name === 'web_search' && args && typeof args.q === 'string' && args.q.trim()) {
                result.searchTarget = args.q.trim();
            }
            return { result, callBack: tool.callBack };
        } catch (e) {
            // stop 中断工具执行：向上抛出让工具链立即中止（不把 StopError 当工具失败回填给模型）
            if (e instanceof StopError) throw e;
            log.exception(`调用函数 (${name}:${tool_call.function.arguments}) 失败`, e);
            return { result: { tool_call_id: tool_call.id, content: `调用函数 (${name}:${tool_call.function.arguments}) 失败:${e instanceof Error ? e.message : String(e)}` }, callBack: true };
        }
    }

    /** 轻量参数校验：按 parameters.properties 的 type 检查 */
    static validateArgs(tool: Tool, args: any): string | null {
        const props = (tool.toolInfo.function.parameters && tool.toolInfo.function.parameters.properties) || {};
        for (const key of Object.keys(props)) {
            if (args[key] === undefined) continue;
            const expected = props[key].type;
            if (expected === 'string' && typeof args[key] !== 'string') return `参数 ${key} 应为字符串`;
            if (expected === 'number' && typeof args[key] !== 'number') return `参数 ${key} 应为数字`;
            if (expected === 'boolean' && typeof args[key] !== 'boolean') return `参数 ${key} 应为布尔值`;
            if (expected === 'array' && !Array.isArray(args[key])) return `参数 ${key} 应为数组`;
            if (expected === 'object' && (typeof args[key] !== 'object' || args[key] === null)) return `参数 ${key} 应为对象`;
        }
        return null;
    }
    static async handleToolCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_calls: ToolCall[]): Promise<{ result: ToolCallResult[], callBack: boolean }> {
        const { MAX_CALL_COUNT } = Config.tool;

        const ret: { result: ToolCallResult[], callBack: boolean } = { result: [], callBack: true };

        for (let i = 0; i < tool_calls.length; i++) {
            const tool_call = tool_calls[i];
            if (MAX_CALL_COUNT > 0 && session.tool.callCount >= MAX_CALL_COUNT) {
                log.warning('工具调用超过上限');
                ret.result.push({
                    tool_call_id: tool_call.id,
                    content: '工具调用超过上限',
                    callBack: true
                });
                ret.callBack = false;
                continue;
            }
            const { result, callBack } = await this.handleToolCall(ctx, msg, session, tool_call);
            result.toolName = tool_call.function.name;
            result.callBack = callBack;
            ret.result.push(result);
            ret.callBack = ret.callBack && callBack;
            session.tool.callCount++;
        }

        return ret;
    }
    static async handlePromptToolCalls(ctx: seal.MsgContext, msg: seal.Message, session: Session, toolCallStr: string): Promise<{ result: ToolCallResult[], callBack: boolean }> {
        try {
            const data = JSON.parse(toolCallStr);
            if (!Array.isArray(data)) {
                log.warning(`解析函数调用失败:tool_calls不是一个数组`);
                return { result: [{ tool_call_id: '', content: `解析函数调用失败:tool_calls不是一个数组` }], callBack: true };
            }
            const tool_calls = data.map((item, index) => {
                if (!Object.prototype.hasOwnProperty.call(item, 'name') || !Object.prototype.hasOwnProperty.call(item, 'arguments')) throw new Error(`缺少name或arguments属性`);
                if (typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error(`name或arguments不是字符串`);
                return {
                    index: index,
                    id: index.toString(),
                    type: "function" as const,
                    function: {
                        name: item.name,
                        arguments: item.arguments
                    }
                };
            });
            return await this.handleToolCalls(ctx, msg, session, tool_calls);
        } catch (e) {
            // stop 中断工具链：向上抛出让工具链立即中止
            if (e instanceof StopError) throw e;
            log.exception('解析函数调用失败', e);
            return { result: [{ tool_call_id: '', content: `解析函数调用失败:${e instanceof Error ? e.message : String(e)}` }], callBack: true };
        }
    }

    static getToolsInfo(session: Session): ToolInfo[] | null {
        const toolState = session.toolState;
        const sessionType = session.sessionType;
        const tools = Object.keys(toolState)
            .map(key => {
                if (!CORE_TOOL_NAMES.includes(key)) return null; // 非核心工具按需加载，不注入 schema
                if (toolState[key]) {
                    if (!Object.prototype.hasOwnProperty.call(toolMap, key)) {
                        log.warning(`在getToolsInfo中找不到工具:${key}`);
                        return null;
                    }
                    const tool: Tool = toolMap[key];
                    if (tool.sessionType !== "any" && tool.sessionType !== sessionType) return null;
                    return tool.toolInfo;
                } else {
                    return null;
                }
            })
            .filter(item => item !== null);

        return tools.length > 0 ? tools : null;
    }

    /** 按需加载工具：非核心且当前会话已开启的工具，供 search_tools 发现 */
    static getOnDemandTools(session: Session): ToolInfo[] {
        const toolState = session.toolState;
        const sessionType = session.sessionType;
        const tools: ToolInfo[] = [];
        for (const key of Object.keys(toolState)) {
            if (CORE_TOOL_NAMES.includes(key) || !toolState[key]) continue;
            if (!Object.prototype.hasOwnProperty.call(toolMap, key)) {
                log.warning(`在getOnDemandTools中找不到工具:${key}`);
                continue;
            }
            const tool: Tool = toolMap[key];
            if (tool.sessionType !== "any" && tool.sessionType !== sessionType) continue;
            tools.push(tool.toolInfo);
        }
        return tools;
    }

    /** 全部可用工具：核心常驻 + 按需加载（均已开启且匹配会话类型），供 search_tools 列名/查详情 */
    static getAvailableTools(session: Session): ToolInfo[] {
        const core = this.getToolsInfo(session) || [];
        return core.concat(this.getOnDemandTools(session));
    }

    static getToolsInfoPrompt(session: Session): string {
        const { PROMPT_ENGINEERING } = Config.tool;

        const tools = this.getToolsInfo(session);
        let s = '';
        if (tools && tools.length > 0) {
            // 模板按扁平结构读取 name/description/parameterText，从 function 字段映射后传入
            const flatTools = tools.map(t => ({
                name: t.function.name,
                description: flattenText(t.function.description, 120),
                parameterText: formatParameterText(t.function.parameters)
            }));
            s = TOOLS_PROMPT_TEMPLATE({
                "PROMPT_ENGINEERING": PROMPT_ENGINEERING,
                "tools": flatTools
            });
        }

        // 按需工具：只给名称 + 一行描述，详细参数通过 search_tools 获取，控制 token 占用
        const onDemand = this.getOnDemandTools(session);
        if (onDemand.length > 0) {
            const summaries = onDemand.slice(0, ON_DEMAND_PROMPT_LIMIT).map((t, i) => {
                const desc = flattenText(t.function.description, 120);
                return `${i + 1}. ${t.function.name}：${desc}`;
            });
            s += `\n\n## 其他可用工具（按需加载）\n${summaries.join('\n')}\n需要使用上述工具时，先调用 search_tools 获取参数说明，再通过 call_tool 执行。`;
            const hiddenCount = onDemand.length - ON_DEMAND_PROMPT_LIMIT;
            if (hiddenCount > 0) {
                s += `\n其余 ${hiddenCount} 个工具请通过 search_tools 查询。`;
            }
        }
        return s;
    }

    /** 返回工具摘要（名称 + 一句话描述），用于 system prompt 静态工具块 */
    static getToolSummaries(session: Session, limit = 100): { summaries: string[]; total: number; truncated: boolean } {
        const tools = this.getAvailableTools(session)
            .sort((a, b) => a.function.name.localeCompare(b.function.name));
        const summaries = tools.map(t => {
            const desc = flattenText(t.function.description, 120);
            return `- ${t.function.name}：${desc}`;
        });
        return {
            summaries: summaries.slice(0, limit),
            total: summaries.length,
            truncated: summaries.length > limit
        };
    }

    /** 原生 function calling 模式：只暴露引导工具 */
    static getNativeRequestTools(session: Session): ToolInfo[] | null {
        const tools = NATIVE_TOOL_NAMES
            .map(name => toolMap[name])
            .filter(Boolean)
            .filter(t => session.toolState?.[t.toolInfo.function.name])
            .filter(t => t.sessionType === 'any' || t.sessionType === session.sessionType)
            .map(t => t.toolInfo);
        return tools.length > 0 ? tools : null;
    }

    /** 提示词工程模式：返回需要完整参数说明的元工具 */
    static getMetaToolInfos(session: Session): ToolInfo[] {
        return META_TOOL_NAMES
            .map(name => toolMap[name])
            .filter(Boolean)
            .filter(t => session.toolState?.[t.toolInfo.function.name])
            .filter(t => t.sessionType === 'any' || t.sessionType === session.sessionType)
            .map(t => t.toolInfo);
    }

    /** 工具获取说明：不列出全部工具，由 AI 通过元工具自行发现 */
    static getToolDiscoveryBlock(_session: Session): string {
        return [
            '## 工具获取',
            '当前不直接列出全部工具。需要发现工具时：',
            '- list_tools：分页查看当前可用工具的名称与描述',
            '- search_tools：按名称或关键词获取某个工具的完整参数说明',
            '- call_tool：执行指定工具'
        ].join('\n');
    }

    /** 提示词工程模式工具块：调用格式 + 元工具参数 + 工具获取说明 */
    static getPromptEngineeringToolBlock(session: Session): string {
        const metaTools = this.getMetaToolInfos(session);
        const flatTools = metaTools.map(t => ({
            name: t.function.name,
            description: flattenText(t.function.description, 120),
            parameterText: formatParameterText(t.function.parameters)
        }));
        const formatPart = TOOLS_PROMPT_TEMPLATE({
            "PROMPT_ENGINEERING": true,
            "tools": flatTools
        });
        const guidePart = this.getToolDiscoveryBlock(session);
        return [formatPart, guidePart].filter(Boolean).join('\n\n');
    }

    /** 原生模式工具块：仅名称 + 描述 */
    static getToolSummaryBlock(session: Session): string {
        const r = this.getToolSummaries(session, 100);
        if (r.summaries.length === 0) return '';
        const lines = ['## 可用工具', ...r.summaries];
        if (r.truncated) {
            lines.push(`（共 ${r.total} 个工具，最多显示 100 个）`);
        }
        lines.push('需要参数详情：search_tools；需要完整列表：list_tools。');
        return lines.join('\n');
    }

}
