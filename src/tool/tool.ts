// 工具系统：Tool 类（调用校验/提示词渲染/分组）；注册表见 registry.ts，注册装配见 bootstrap.ts
import Config from "../config/config"
import Logger from "../logger"
import { Session } from "../session/session";
import { SessionType } from "../session/types";
import { matchesPlatform } from "../utils/target_id";
import { StopError } from "../utils/timeout";

import { executeTool, type ToolFailure, validateToolArgs } from "./executor";
import { clearToolMap, toolMap } from "./registry";
import { ToolCall, ToolCallResult, ToolInfo, ToolSolveContent } from "./types";

// 兼容旧引用：toolMap 已迁至 ./registry（实现侧请直接 import ./registry）
export { toolMap };

const log = Logger.withTag('tool');

/** function calling 路径的错误文案（模型可见，英文） */
function functionCallErrorText(name: string, rawArgs: string, failure?: ToolFailure): string {
    switch (failure?.code) {
        case 'not_found': return `Function call failed: unknown function "${name}". Call search_tools to see available tools.`;
        case 'not_enabled': return `Function call failed: function "${name}" is not enabled in this session.`;
        case 'session_type': return `Function call failed: function "${name}" supports session type ${failure.expected}, current type is ${failure.actual}.`;
        case 'missing_required': return `Function call failed: missing required parameter "${failure.param}".`;
        case 'invalid_arg': return `Function call failed: ${failure.message}`;
        case 'bad_args': return `Function call (${name}:${rawArgs}) failed: ${failure.message}`;
        default: return `Function call (${name}:${rawArgs}) failed: ${failure?.message ?? 'unknown error'}`;
    }
}

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
export const SKILL_GROUP = 'Skills';
export const KNOWLEDGE_GROUP = 'Knowledge';
export const NON_GROUPABLE_GROUPS: string[] = [SKILL_GROUP, KNOWLEDGE_GROUP];

/** 内置工具分类缺省兜底 / 外部插件（globalThis.aiplugin4.registerTool）注册工具的固定分类 */
export const DEFAULT_CATEGORY = 'Other';
export const EXTERNAL_CATEGORY = 'External plugins';

/** 内置分类的固定展示顺序（未列入的分类按名称追加在末尾，避免依赖 localeCompare 排序） */
export const BUILTIN_CATEGORY_ORDER: string[] = [
    'Dispatch', 'Commands', 'Timers', 'Triggers', 'Memory', 'Images', 'Media', 'OB11', 'Resources',
    'Attributes', 'Raw search', 'Context editing', 'Blocks', 'Web', 'Public sessions', 'Subagents', 'MCP',
    DEFAULT_CATEGORY, EXTERNAL_CATEGORY
];

/** 工具组：内置分类组（kind=builtin，key=分类名）或 MCP 服务器组（kind=mcp，key=服务器名） */
export interface ToolGroupInfo {
    /** 解析键：分类名 / MCP 服务器名 */
    key: string;
    /** 显示名：builtin · Memory / mcp-files-exec */
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

export default class Tool {
    toolInfo: ToolInfo;
    sessionType: 'any' | SessionType; // 可使用函数的会话类型
    callBack: boolean; // 是否回调智能体
    sensitive: boolean; // 敏感工具（发送消息/封禁/改名等），调用会显著记录
    /** 来源分组：内置工具为空；技能工具='Skills'；知识库工具='Knowledge'；MCP 工具=所属服务器名 */
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
        clearToolMap();
    }

    /**
     * 模型 function calling 入口：解析参数（含 JSON 修复）→ 统一执行器。
     * 校验/超时/审计/错误归一化都在 src/tool/executor.ts，本方法只负责包装回 ToolCallResult 文案。
     */
    static async handleToolCall(ctx: seal.MsgContext, msg: seal.Message, session: Session, tool_call: ToolCall): Promise<{ result: ToolCallResult, callBack: boolean }> {
        const name = tool_call.function.name;
        const rawArgs = tool_call.function.arguments;
        const execution = await executeTool(name, ctx, msg, session, { source: 'function', args: rawArgs, repairJson: true });
        if (!execution.ok) {
            return { result: { tool_call_id: tool_call.id, content: functionCallErrorText(name, rawArgs, execution.failure) }, callBack: true };
        }
        const result: ToolCallResult = { tool_call_id: tool_call.id, content: execution.content ?? '' };
        if (execution.contentParts && execution.contentParts.length > 0) result.contentParts = execution.contentParts;
        return { result, callBack: execution.callBack ?? true };
    }

    /** 兼容旧调用点：参数校验实现已统一到 executor.validateToolArgs */
    static validateArgs(tool: Tool, args: any): string | null {
        return validateToolArgs(tool, args);
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

    /** 来源分组显示名：无 group 的内置工具显示 builtin（平台限制等错误文案沿用该口径） */
    static groupLabel(group?: string): string {
        return group || 'builtin';
    }

    /** 工具的分类名：仅内置工具（group 为空）有分类，缺省兜底 Other；非内置工具返回空串 */
    static categoryOf(tool?: Tool): string {
        if (!tool || tool.group) return '';
        return tool.category || DEFAULT_CATEGORY;
    }

    /** 工具是否属于可切换的工具组（Skills/Knowledge 由 .ai skill / .ai kb 管理，不参与组维度） */
    static isGroupable(tool?: Tool): boolean {
        if (!tool) return false;
        return !(!!tool.group && NON_GROUPABLE_GROUPS.includes(tool.group));
    }

    /** 工具所属组的显示名：内置工具=`builtin · 分类`，其余=来源分组（技能/知识库/MCP 服务器名） */
    static groupDisplay(tool?: Tool): string {
        if (!tool) return DEFAULT_CATEGORY;
        if (tool.group) return tool.group;
        return `builtin · ${Tool.categoryOf(tool)}`;
    }

    /** 分组过滤匹配：来源分组（原 mcp= 语义）/ 分类名 / 组显示名 / `builtin` 任一命中 */
    static matchesGroupFilter(tool: Tool | undefined, filter: string): boolean {
        const f = String(filter || '').trim();
        if (!f) return true;
        if (!tool) return false;
        if (tool.group === f || Tool.groupDisplay(tool) === f) return true;
        if (!tool.group && (Tool.categoryOf(tool) === f || f === 'builtin')) return true;
        return false;
    }

    /**
     * 按组聚合工具名。组内按工具名排序。
     *
     * 内部聚合键必须带 kind 前缀（`builtin:Memory` / `mcp:Memory`）：分类名与 MCP 服务器名共用一个命名空间，
     * 而 MCP 服务器名来自 mcpServers 的键、无保留字校验 —— 若直接拿 name 当键，一台名为 "Memory" 的
     * MCP 服务器会被并进内置 Memory 组（概览显示成 `builtin · Memory`），`.ai tool off Memory` 会连带关掉 MCP 工具
     * 且完全看不出来；服务器取名 "Skills" 还会让整个 MCP 组因 isGroupable 判定而从概览消失。
     * 对外的 key/label 保持原样（命令参数与显示都依赖它，且 .ai tool 的 MCP 空服务器提示需要按名字比对）。
     */
    private static groupEntries(entries: { name: string; tool: Tool }[]): { key: string; label: string; kind: 'builtin' | 'mcp'; names: string[] }[] {
        const map: { [key: string]: { key: string; label: string; kind: 'builtin' | 'mcp'; names: string[] } } = {};
        for (const { name, tool } of entries) {
            const kind: 'builtin' | 'mcp' = tool.group ? 'mcp' : 'builtin';
            const key = tool.group || Tool.categoryOf(tool);
            const bucket = `${kind}:${key}`;
            if (!map[bucket]) map[bucket] = { key, label: Tool.groupDisplay(tool), kind, names: [] };
            map[bucket].names.push(name);
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
     * 按组返回当前会话可用（已开启、平台匹配）的工具，组头用统一显示名（builtin · Memory / MCP 服务器名 / Skills / Knowledge）。
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

}
