// 通用 MCP 适配器（L3）：把「用户勾选」的任意 MCP 服务器工具包装成辅助工具。
//
// 默认不暴露任何服务器（选择由 M2 装配传入）：通用 MCP 工具全部 `toolsets: []`，
// 因此默认不进任何 toolset，也不会被摘要场景挂载（方案 §10.4「默认不进 toolset」）。
// 风险优先用 annotations.readOnlyHint/destructiveHint，缺注解按 read；写/危险工具需要
// 调用方显式勾选服务器并把工具放进 toolset（M2 的 UI 负责，本层只做元数据）。
import type { AuxCapabilityAdapter, AuxToolDescriptor, AuxToolHandler } from '../../core/ports/aux_tools';
import { getMCPServers } from '../../tool/mcp/config';
import type { MCPServer, MCPToolDef } from '../../tool/mcp/config';

import { riskOfAnnotations } from './shared';
import { callMcpText, listServerTools, mcpToolDescriptor, namespacedToolName } from './shared';

export interface GenericMcpAdapterOptions {
    /** 用户勾选的 MCP 服务器名；空数组 = 不暴露任何工具（默认） */
    servers?: string[];
    /** 已解析服务器配置（默认 getMCPServers；测试注入） */
    listMcpServers?: () => MCPServer[];
    /** 某服务器已同步的工具列表（默认 serverStates；测试注入） */
    listServerTools?: (server: string) => MCPToolDef[];
    /** 执行 MCP 工具（默认 callMCPTool 文本化；测试注入） */
    callMcp?: (server: string, tool: string, args: unknown, sessionKey: string) => Promise<string>;
}

export function createGenericMcpAdapter(opts: GenericMcpAdapterOptions = {}): AuxCapabilityAdapter {
    // 复制一份，避免调用方后续改数组影响元数据；选择变化由 M2 重新 install 适配器
    const selected = Array.from(new Set((opts.servers || []).filter(Boolean)));
    const listMcpServers = opts.listMcpServers || getMCPServers;
    const listTools = opts.listServerTools || listServerTools;
    const callMcp = opts.callMcp || callMcpText;

    const selectedServers = (): MCPServer[] => {
        if (selected.length === 0) return [];
        try {
            return listMcpServers().filter(server => selected.includes(server.name));
        } catch {
            return [];
        }
    };

    const descriptors = (): Array<{ descriptor: AuxToolDescriptor; server: string; tool: string }> => {
        const out: Array<{ descriptor: AuxToolDescriptor; server: string; tool: string }> = [];
        for (const server of selectedServers()) {
            for (const def of listTools(server.name)) {
                if (!def || !def.name) continue;
                out.push({
                    server: server.name,
                    tool: def.name,
                    descriptor: mcpToolDescriptor(def, namespacedToolName(server.name, def.name), {
                        risk: riskOfAnnotations(def.annotations),
                        consumers: ['summarizer'],
                        // 默认不进任何 toolset：调用方必须显式挂载（或后续版本按配置勾选）
                        toolsets: [],
                        needsContext: false,
                    }),
                });
            }
        }
        return out;
    };

    return {
        id: 'mcp-generic',
        kind: 'mcp',
        displayName: 'Selected MCP servers',
        tools(): AuxToolDescriptor[] {
            return descriptors().map(item => item.descriptor);
        },
        handler(name: string): AuxToolHandler | null {
            // 名字格式 `<server>__<tool>`：按服务器前缀反查（同名工具跨服务器不串）
            const hit = descriptors().find(item => item.descriptor.name === name);
            if (!hit) return null;
            return async (args: unknown, env): Promise<string> => {
                const sessionKey = env.context?.sessionId || '';
                return callMcp(hit.server, hit.tool, args, sessionKey);
            };
        },
        /** 服务器选择 + 工具数量（选择是静态的，工具列表随 MCP 热同步变化） */
        revision(): number {
            let total = selected.length * 1000;
            for (const server of selectedServers()) total += listTools(server.name).length;
            return total;
        },
    };
}
