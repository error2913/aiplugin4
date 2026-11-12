// 能力段（`core:capabilities`，order 450）：工具获取入口的**常量**说明。
//
// #163 D1-08：不再枚举当前会话的工具组/已开启工具（那会让 S 随工具开关、MCP 连断、平台过滤
// 变化）。能力发现改由 list_tools / search_tools / call_tool 现场查询。
//
// 兼容保留：MCP 用途标签 provider（`src/tool/mcp.ts` 在模块加载时注册）。S 已不再使用它，
// 但删除会波及 tool 域，故保留导出与注册点。
import { CAPABILITIES_STATIC } from '../texts/en';
import type { PromptContext, PromptSection } from '../types';

/** MCP 服务器用途标签 provider（tool/mcp 注册） */
export type McpCapabilityLabelProvider = (serverName: string) => string;
let mcpLabelProvider: McpCapabilityLabelProvider | null = null;

/** 由 tool/mcp 在装配时注册（兼容保留，S 不再使用） */
export function setMcpCapabilityLabelProvider(next: McpCapabilityLabelProvider | null): void {
    mcpLabelProvider = next;
}

/** 清空 provider（测试 / JS 重载用） */
export function resetMcpCapabilityLabelProvider(): void {
    mcpLabelProvider = null;
}

/** 读取当前 provider 的标签（仍供 `.ai tool` 概览复用；S 不再调用） */
export function mcpCapabilityLabel(serverName: string): string {
    return mcpLabelProvider ? mcpLabelProvider(serverName) : serverName;
}

/** 组装能力段文本；STATUS 关闭时返回空串（常量：与工具开关无关）。 */
export function buildCapabilitiesSection(ctx: PromptContext): string {
    return ctx.flags.status ? CAPABILITIES_STATIC : '';
}

export function registerCapabilitySections(): PromptSection[] {
    return [{
        name: 'core:capabilities',
        order: 450,
        channel: 'system',
        maxChars: 2000,
        // 常量段：不枚举当前工具组；能力发现改由 list_tools / search_tools 现场查询
        cache: { deps: c => [c.flags.status] },
        build: ctx => buildCapabilitiesSection(ctx),
    }];
}
