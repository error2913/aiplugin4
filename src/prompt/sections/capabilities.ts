// 能力地图段：让模型知道自己“有哪些域的能力”，而不必先调用 list_tools。
// 数据来自当前会话已注册、已开启、平台匹配的工具组；只列域 + 2 个代表工具名，参数仍由 search_tools 提供。
// MCP 服务器的用途标签由 tool/mcp 通过 provider 提供（配置 description > serverInfo.title > 服务器名）。
import Tool from '../../tool/tool';
import type { PromptContext, PromptSection } from '../types';

/** 内置工具分类 → 一句能力用途（英文；新增分类时同步补充，缺省回退 "miscellaneous tools"） */
const GROUP_PURPOSE: { [key: string]: string } = {
    'Dispatch': 'discover and execute tools',
    'Commands': 'run SealDice core/extension commands',
    'Timers': 'schedule, list and cancel reminders/timers',
    'Triggers': 'set trigger conditions for when the bot should speak',
    'Memory': 'remember, recall, update or delete long-term memory and mental models',
    'Images': 'view, describe, generate and send images; manage the image gallery',
    'Media': 'check or cancel voice/image generation tasks',
    'OB11': 'call OneBot 11 APIs: messages, queries, group admin, files, forward',
    'Resources': 'find local resources and generated media',
    'Attributes': 'read or write SealDice character attributes',
    'Raw search': 'read original content and resolve compressed/truncated context references',
    'Context editing': 'locate and edit conversation context entries',
    'Blocks': 'block or unblock users/groups',
    'Web': 'web search, web fetch and forum operations',
    'Public sessions': 'browse/read other sessions and send cross-session messages',
    'Subagents': 'delegate work to subagents and manage background jobs',
    'MCP': 'list and read resources exposed by MCP servers',
    'Other': 'miscellaneous tools',
    'External plugins': 'tools registered by other SealDice plugins',
};

/** MCP 服务器用途标签 provider（tool/mcp 注册；缺失时回退服务器名） */
export type McpCapabilityLabelProvider = (serverName: string) => string;
let mcpLabelProvider: McpCapabilityLabelProvider | null = null;

/** 由 tool/mcp 在装配时注册 */
export function setMcpCapabilityLabelProvider(next: McpCapabilityLabelProvider | null): void {
    mcpLabelProvider = next;
}

/** 清空 provider（测试 / JS 重载用） */
export function resetMcpCapabilityLabelProvider(): void {
    mcpLabelProvider = null;
}

function toolStateSignature(ctx: PromptContext): string {
    const state = ctx.session.toolState || {};
    return Object.keys(state).sort().map(key => `${key}:${state[key] ? 1 : 0}`).join(',');
}

/** MCP 标签签名（服务器名 + 用途标签，参与缓存 key） */
function mcpLabelSignature(ctx: PromptContext): string {
    const groups = Tool.getToolGroups(ctx.session, ctx.platform).filter(group => group.kind === 'mcp');
    return groups
        .map(group => `${group.key}:${mcpLabelProvider ? mcpLabelProvider(group.key) : ''}`)
        .sort()
        .join('|');
}

/** 组装能力地图文本；STATUS 关闭或无任何已开启工具时返回空串。 */
export function buildCapabilitiesSection(ctx: PromptContext): string {
    if (!ctx.flags.status) return '';
    const lines: string[] = [];
    const groups = Tool.getToolGroups(ctx.session, ctx.platform);
    for (const group of groups) {
        const enabled = group.names.filter(name => ctx.session.toolState?.[name] === true);
        if (enabled.length === 0) continue;
        const examples = enabled.slice(0, 2);
        if (group.kind === 'mcp') {
            const label = mcpLabelProvider ? mcpLabelProvider(group.key) : group.key;
            lines.push(`- MCP server "${group.key}" — ${label}; ${enabled.length} tools, e.g. ${examples.join(', ')}`);
            continue;
        }
        const purpose = GROUP_PURPOSE[group.key] || 'miscellaneous tools';
        lines.push(`- ${group.key} — ${purpose}; e.g. ${examples.join(', ')}`);
    }
    if (lines.length === 0) return '';
    return [
        '## Capabilities',
        'You have tools in these domains (only domains enabled in this session are listed):',
        ...lines,
        '',
        'If a task matches one of these domains but you are unsure which tool to use, call `list_tools` (overview) or `search_tools` (parameter docs) before replying that you cannot do it. Tools disabled in this session cannot be called.',
    ].join('\n');
}

export function registerCapabilitySections(): PromptSection[] {
    return [{
        name: 'core:capabilities',
        order: 450,
        channel: 'system',
        maxChars: 2000,
        cache: {
            deps: ctx => [
                ctx.flags.status,
                ctx.flags.promptEngineering,
                ctx.platform,
                toolStateSignature(ctx),
                mcpLabelSignature(ctx),
            ],
        },
        build: ctx => buildCapabilitiesSection(ctx),
    }];
}
