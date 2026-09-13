// 工具系统：Tool 注册表、工具调用（含扩展指令/提示词工程）与注册
import Config from "../config/config"
import Logger from "../logger"
import { TOOLS_PROMPT_TEMPLATE } from "../prompt/templates"
import { Session } from "../session/session";
import { SessionType } from "../session/types";
import { fixJsonString } from "../utils/string";
import { matchesPlatform } from "../utils/target_id";
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
    'list_tools', // 工具列表（名称+描述，按工具组分组）
    'search_tools', // 按需发现工具（返回完整参数说明）
    'list_mcps',    // 列出所有 MCP 服务器及其工具
    'call_tool',    // 统一执行入口（调用任意已开启工具）
    'use_skill',    // 技能调用
    'call_ob11_api', // 唯一 OB11 API 调用入口
    'run_ext_command',  // 扩展指令调用
    'run_core_command' // 核心指令调用
];

/** 原生 function calling 模式下只向 API 暴露的引导工具 */
export const NATIVE_TOOL_NAMES: string[] = ['list_tools', 'search_tools', 'call_tool'];

/** 不参与工具组维度的来源分组：技能/知识库的会话开关由 .ai skill / .ai kb 管理（单工具开关不受影响） */
export const SKILL_GROUP = '技能';
export const KNOWLEDGE_GROUP = '知识库';
export const NON_GROUPABLE_GROUPS: string[] = [SKILL_GROUP, KNOWLEDGE_GROUP];

/** 内置工具分类缺省兜底 / 外部插件（globalThis.aiplugin4.registerTool）注册工具的固定分类 */
export const DEFAULT_CATEGORY = '其他';
export const EXTERNAL_CATEGORY = '外部插件';

/** 内置分类的固定展示顺序（未列入的分类按名称追加在末尾，避免依赖中文 localeCompare 排序） */
export const BUILTIN_CATEGORY_ORDER: string[] = [
    '基础调度', '指令', '定时', '触发', '记忆', '图片', 'OB11', '资源',
    '属性', '原文检索', '黑名单', '网页', '公开会话', '子代理',
    DEFAULT_CATEGORY, EXTERNAL_CATEGORY
];

/** 工具组：内置分类组（kind=builtin，key=分类名）或 MCP 服务器组（kind=mcp，key=服务器名） */
export interface ToolGroupInfo {
    /** 解析键：分类名 / MCP 服务器名 */
    key: string;
    /** 显示名：内置·记忆 / mcp-files-exec */
    label: string;
    kind: 'builtin' | 'mcp';
    /** 组内工具名（按名称排序、已按当前平台过滤、不含禁止名单中的工具） */
    names: string[];
    on: number;
    off: number;
}

/** 注册批次内的当前分类（withCategory 维护，仅对未显式指定 group 的内置工具生效） */
let currentCategory: string | null = null;

/** 提示词工程模式下需要完整参数说明的元工具 */
export const META_TOOL_NAMES: string[] = [
    'list_tools',
    'search_tools',
    'list_mcps',
    'call_tool',
    'skill_list',
    'use_skill',
    'knowledge_list',
    'knowledge_docs',
    'knowledge_search',
    'knowledge_read',
    'subagent',
    'subagent_fork',
    'send_message',
    'interrupt_agent',
    'list_agents',
    'job_output',
    'job_list',
    'job_kill'
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
    /** 来源分组：内置工具为空；技能工具='技能'；知识库工具='知识库'；MCP 工具=所属服务器名 */
    group?: string;
    /** 内置工具的细分分类（仅 group 为空时赋值）：用于 .ai tool 组概览与批量开关、AI 侧组头显示 */
    category?: string;
    /** 平台白名单（继承自源单元：MCP 服务器/技能/知识库的 platform），缺省 = 所有平台 */
    platforms?: string[];
    solve: (ctx: seal.MsgContext, msg: seal.Message, session: Session, args: { [key: string]: any }) => Promise<string | ToolSolveContent>;

    constructor(info: ToolInfo, sensitive = false, group?: string, platforms?: string[]) {
        this.toolInfo = info;
        this.sensitive = sensitive;
        this.sessionType = "any";
        this.callBack = true;
        this.group = group;
        // 分类只对内置工具（group 为空）生效：技能/知识库/MCP 工具的组维度就是其来源分组
        this.category = group ? undefined : (currentCategory || undefined);
        this.platforms = platforms;
        this.solve = async (_, __, ___, ____) => "函数未实现";

        toolMap[info.function.name] = this;
    }

    /**
     * 在指定分类下注册一批内置工具（注册批次包装，避免逐个 new Tool 传分类）。
     * 只对批次内未显式指定 group 的工具赋值 category；仅用于同步注册批次。
     */
    static withCategory<T>(category: string, fn: () => T): T {
        if (currentCategory !== null) {
            log.warning(`withCategory 嵌套调用（${currentCategory} → ${category}），内层分类生效`);
        }
        const prev = currentCategory;
        currentCategory = category;
        try {
            return fn();
        } finally {
            currentCategory = prev;
        }
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

    /** 平台白名单是否放行当前平台；platform 缺省时不做过滤 */
    static isAllowedPlatform(tool: Tool, platform?: string): boolean {
        if (!platform) return true;
        return matchesPlatform(tool.platforms, platform);
    }

    /** 来源分组显示名：无 group 的内置工具显示「内置」（平台限制等错误文案沿用该口径） */
    static groupLabel(group?: string): string {
        return group || '内置';
    }

    /** 工具的分类名：仅内置工具（group 为空）有分类，缺省兜底「其他」；非内置工具返回空串 */
    static categoryOf(tool?: Tool): string {
        if (!tool || tool.group) return '';
        return tool.category || DEFAULT_CATEGORY;
    }

    /** 工具是否属于可切换的工具组（技能/知识库由 .ai skill / .ai kb 管理，不参与组维度） */
    static isGroupable(tool?: Tool): boolean {
        if (!tool) return false;
        return !(!!tool.group && NON_GROUPABLE_GROUPS.includes(tool.group));
    }

    /** 工具所属组的显示名：内置工具=「内置·分类」，其余=来源分组（技能/知识库/MCP 服务器名） */
    static groupDisplay(tool?: Tool): string {
        if (!tool) return DEFAULT_CATEGORY;
        if (tool.group) return tool.group;
        return `内置·${Tool.categoryOf(tool)}`;
    }

    /** 分组过滤匹配：来源分组（原 mcp= 语义）/ 分类名 / 组显示名 / 「内置」任一命中 */
    static matchesGroupFilter(tool: Tool | undefined, filter: string): boolean {
        const f = String(filter || '').trim();
        if (!f) return true;
        if (!tool) return false;
        if (tool.group === f || Tool.groupDisplay(tool) === f) return true;
        if (!tool.group && (Tool.categoryOf(tool) === f || f === '内置')) return true;
        return false;
    }

    /** 按组聚合工具名：组键=分类名或来源分组，显示名取 groupDisplay，组内按工具名排序 */
    private static groupEntries(entries: { name: string; tool: Tool }[]): { key: string; label: string; kind: 'builtin' | 'mcp'; names: string[] }[] {
        const map: { [key: string]: { key: string; label: string; kind: 'builtin' | 'mcp'; names: string[] } } = {};
        for (const { name, tool } of entries) {
            const kind: 'builtin' | 'mcp' = tool.group ? 'mcp' : 'builtin';
            const key = tool.group || Tool.categoryOf(tool);
            if (!map[key]) map[key] = { key, label: Tool.groupDisplay(tool), kind, names: [] };
            map[key].names.push(name);
        }
        const groups = Object.keys(map).map(k => map[k]);
        for (const g of groups) g.names.sort((a, b) => a.localeCompare(b));
        // 内置分类按固定顺序在前，MCP 服务器组按名称在后；未列入顺序表的分类排在已知分类之后
        const rank = (g: { kind: string; key: string }) => {
            if (g.kind === 'mcp') return 10000;
            const i = BUILTIN_CATEGORY_ORDER.indexOf(g.key);
            return i === -1 ? 9000 : i;
        };
        groups.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
        return groups;
    }

    /**
     * 当前会话的全部已注册工具按组列出（含已关闭的工具，排除技能/知识库组），供 .ai tool 组概览与批量开关用。
     * 计数直接读 session.toolState：自动继承平台过滤、禁止名单剔除、默认关闭与子代理工具面收窄。
     */
    static getToolGroups(session: Session, platform?: string): ToolGroupInfo[] {
        const state = session.toolState;
        const entries: { name: string; tool: Tool }[] = [];
        for (const name of Object.keys(state)) {
            const tool = toolMap[name];
            if (!tool) continue;
            if (!Tool.isGroupable(tool)) continue;
            if (!Tool.isAllowedPlatform(tool, platform)) continue;
            entries.push({ name, tool });
        }
        return Tool.groupEntries(entries).map(g => {
            const on = g.names.filter(n => !!state[n]).length;
            return { key: g.key, label: g.label, kind: g.kind, names: g.names, on, off: g.names.length - on };
        });
    }

    /** 按显示名/分类名/服务器名解析工具组：精确优先，其次唯一包含匹配；返回字符串即错误说明 */
    static resolveToolGroup(arg: string, groups: ToolGroupInfo[]): ToolGroupInfo | string {
        const raw = String(arg || '').trim();
        if (raw === '') return '未指定工具组名；可用 .ai tool 查看全部组';
        const lower = raw.toLowerCase();
        const exact = groups.filter(g => g.key === raw || g.label === raw || g.key.toLowerCase() === lower || g.label.toLowerCase() === lower);
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) return `「${raw}」匹配多个工具组：${exact.map(g => g.key).join('、')}；请写全名（可用 --group=）`;
        const fuzzy = groups.filter(g => g.key.toLowerCase().includes(lower) || g.label.toLowerCase().includes(lower));
        if (fuzzy.length === 1) return fuzzy[0];
        if (fuzzy.length === 0) return `未找到工具组「${raw}」；可用 .ai tool 查看全部组`;
        return `「${raw}」匹配多个工具组：${fuzzy.map(g => g.key).join('、')}；请写全名（可用 --group=）`;
    }

    static getToolsInfo(session: Session, platform?: string): ToolInfo[] | null {
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
                    if (!Tool.isAllowedPlatform(tool, platform)) return null;
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
    static getOnDemandTools(session: Session, platform?: string): ToolInfo[] {
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
            if (!Tool.isAllowedPlatform(tool, platform)) continue;
            if (tool.sessionType !== "any" && tool.sessionType !== sessionType) continue;
            tools.push(tool.toolInfo);
        }
        return tools;
    }

    /** 全部可用工具：核心常驻 + 按需加载（均已开启、匹配会话类型与平台），供 search_tools 列名/查详情 */
    static getAvailableTools(session: Session, platform?: string): ToolInfo[] {
        const core = this.getToolsInfo(session, platform) || [];
        return core.concat(this.getOnDemandTools(session, platform));
    }

    /**
     * 按组返回当前会话可用（已开启、平台匹配）的工具，组头用统一显示名（内置·记忆 / MCP 服务器名 / 技能 / 知识库）。
     * 与 .ai tool 共用同一分组实现；此处不排除技能/知识库（AI 侧发现需要看到它们）。
     */
    static getGroupedAvailableTools(session: Session, platform?: string): { group: string; key: string; kind: 'builtin' | 'mcp'; tools: ToolInfo[] }[] {
        const infos = this.getAvailableTools(session, platform);
        const entries = infos
            .map(info => ({ name: info.function.name, tool: toolMap[info.function.name] }))
            .filter(e => !!e.tool);
        return Tool.groupEntries(entries).map(g => ({
            group: g.label,
            key: g.key,
            kind: g.kind,
            tools: g.names.map(n => toolMap[n].toolInfo)
        }));
    }

    static getToolsInfoPrompt(session: Session, platform?: string): string {
        const { PROMPT_ENGINEERING } = Config.tool;

        const tools = this.getToolsInfo(session, platform);
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
        const onDemand = this.getOnDemandTools(session, platform);
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

    /** 返回工具摘要（名称 + 一句话描述），用于 system prompt 静态工具块（平台过滤） */
    static getToolSummaries(session: Session, limit = 100, platform?: string): { summaries: string[]; total: number; truncated: boolean } {
        const tools = this.getAvailableTools(session, platform)
            .sort((a, b) => a.function.name.localeCompare(b.function.name));
        const summaries = tools.map(t => {
            const tool = toolMap[t.function.name];
            const group = Tool.groupDisplay(tool);
            const desc = flattenText(t.function.description, 120);
            return `- ${t.function.name}：${desc}（来源：${group}）`;
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

    /** 提示词工程模式：返回需要完整参数说明的元工具（平台过滤） */
    static getMetaToolInfos(session: Session, platform?: string): ToolInfo[] {
        return META_TOOL_NAMES
            .map(name => toolMap[name])
            .filter(Boolean)
            .filter(t => session.toolState?.[t.toolInfo.function.name])
            .filter(t => t.sessionType === 'any' || t.sessionType === session.sessionType)
            .filter(t => Tool.isAllowedPlatform(t as Tool, platform))
            .map(t => t.toolInfo);
    }

    /** 工具获取说明：不列出全部工具，由 AI 通过元工具自行发现 */
    static getToolDiscoveryBlock(_session: Session): string {
        return [
            '## 工具获取',
            '当前不直接列出全部工具。需要发现工具时：',
            '- list_tools：分页查看当前可用工具的名称与描述（按工具组分组）',
            '- search_tools：按名称/关键词/MCP 服务器获取工具的完整参数说明',
            '- list_mcps：列出当前平台可用的全部 MCP 服务器及其工具',
            '- call_tool：执行指定工具'
        ].join('\n');
    }

    /** 提示词工程模式工具块：调用格式 + 元工具参数 + 工具获取说明 */
    static getPromptEngineeringToolBlock(session: Session, platform?: string): string {
        const metaTools = this.getMetaToolInfos(session, platform);
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

    /** 原生模式工具块：仅名称 + 描述（按工具组分组） */
    static getToolSummaryBlock(session: Session, platform?: string): string {
        const r = this.getToolSummaries(session, 100, platform);
        if (r.summaries.length === 0) return '';
        const lines = ['## 可用工具', ...r.summaries];
        if (r.truncated) {
            lines.push(`（共 ${r.total} 个工具，最多显示 100 个）`);
        }
        lines.push('需要参数详情：search_tools；需要完整列表：list_tools。');
        return lines.join('\n');
    }

}
