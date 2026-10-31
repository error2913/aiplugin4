// 适配器共享工具（L3）：MCP 来源的命名/风险映射/参数包装/文本提取。
// 只在 adapters/* 内部复用；不写提示词文案（文案在 prompt/texts），不读写会话开关。
import type { AuxRisk, AuxToolDescriptor } from '../../core/ports/aux_tools';
import { callMCPTool } from '../../tool/mcp';
import { serverStates } from '../../tool/mcp/client';
import type { MCPToolDef } from '../../tool/mcp/config';
import { mcpText } from '../../tool/mcp/result';
import type { MCPToolAnnotations } from '../../tool/mcp/types';

/** 默认读取已同步的 MCP 工具列表（serverStates 是注册器维护的运行时快照；测试可注入替身） */
export function listServerTools(server: string): MCPToolDef[] {
    return serverStates[server]?.tools || [];
}

/** 工具名清洗：模型/协议只接受 `[A-Za-z0-9_-]`，其它字符替换为下划线 */
export function sanitizeNamePart(raw: string): string {
    const cleaned = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '_');
    return cleaned || '_';
}

/**
 * 暴露给模型的工具名：`<server>__<tool>`（双下划线）。
 * MCP 注册到主工具表的名字是裸工具名（可能跨服务器同名覆盖），辅助工具必须带服务器命名空间，
 * 否则多个 MCP 服务器的同名工具在 registry.handler(name) 上会互相抢（方案 §10.4）。
 */
export function namespacedToolName(server: string, tool: string): string {
    return `${sanitizeNamePart(server)}__${sanitizeNamePart(tool)}`;
}

/** MCP annotations → 辅助风险等级：destructiveHint=危险、readOnlyHint/缺省=read（写操作靠适配器显式覆盖） */
export function riskOfAnnotations(annotations?: MCPToolAnnotations | null): AuxRisk {
    if (annotations && typeof annotations === 'object' && annotations.destructiveHint === true) return 'dangerous';
    return 'read';
}

/** 把 MCP inputSchema 包装成 OpenAI function.parameters（保证 object 根 + required 数组） */
export function wrapParameters(schema: unknown): Record<string, unknown> {
    const raw = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...(schema as Record<string, unknown>) } : {};
    if (raw.type !== 'object') {
        // 非 object 根 schema（部分服务器省略 type）统一按空对象处理，避免把错误 schema 直接发给模型
        return { type: 'object', properties: {}, required: [] };
    }
    return {
        ...raw,
        properties: raw.properties && typeof raw.properties === 'object' ? raw.properties : {},
        required: Array.isArray(raw.required) ? raw.required : [],
    };
}

/** 单个 MCP 工具的元数据描述：名字由调用方加命名空间（不同来源的显示前缀不同） */
export function mcpToolDescriptor(tool: MCPToolDef, name: string, opts: {
    risk?: AuxRisk;
    consumers: AuxToolDescriptor['consumers'];
    toolsets: AuxToolDescriptor['toolsets'];
    needsContext: boolean;
}): AuxToolDescriptor {
    return {
        name,
        description: String(tool.description || `MCP tool ${tool.name}`).slice(0, 1000),
        parameters: wrapParameters(tool.inputSchema),
        risk: opts.risk ?? riskOfAnnotations(tool.annotations),
        consumers: opts.consumers,
        toolsets: opts.toolsets,
        needsContext: opts.needsContext,
    };
}

/** 调用 MCP 工具并返回文本（辅助调用不注入图片块；图片引用保留在文本里由模型决定是否进一步查看） */
export async function callMcpText(server: string, tool: string, args: unknown, sessionKey: string): Promise<string> {
    const result = await callMCPTool(server, tool, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>, sessionKey);
    const text = mcpText(result);
    const imageBlocks = Array.isArray(result && result.content)
        ? result.content.filter(block => block && block.type === 'image').length
        : 0;
    if (imageBlocks > 0) {
        // 摘要智能体不做多模态：明确告知图片块已省略，避免模型以为拿到了图
        return `${text}${text ? '\n' : ''}[${imageBlocks} image block(s) omitted in auxiliary call]`;
    }
    return text;
}
