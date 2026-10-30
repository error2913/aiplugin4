// 图床来源适配器（L3）：后端图床（ImageHost.enabled）或带 `capability:'image-host'` 的 MCP 服务器。
//
// 注册条件（方案 §10.4，防回归关键）：后端图床已配置 **或** 存在带 image-host 能力的 MCP 时注册；
// 否则不注册 —— builder 的 `imageHost = auxRegistry.hasSnippet('image-host')` 因此等价于旧
// `ImageHost.enabled || MCP_ENABLED`（只是 MCP 那部分收窄为「真的有图床能力」）。
//
// 工具只来自 MCP 图床（后端图床当前没有 search/keep/unkeep HTTP 客户端，只有上传/取字节）：
//   image_search（read）/ image_keep / image_unkeep / image_tag（write），均属 summary-image。
// 工具名带服务器命名空间（`<server>__<tool>`），handler 走 callMCPTool。
import type { AuxCapabilityAdapter, AuxSnippetDescriptor, AuxToolDescriptor, AuxToolHandler } from '../../core/ports/aux_tools';
import Image from '../../resource/image';
import { ImageHost } from '../../resource/image_host';
import { ImageIndex } from '../../resource/image_index';
import type { ImageIndexEntry } from '../../resource/image_index';
import { getMCPServers } from '../../tool/mcp/config';
import type { MCPServer, MCPToolDef } from '../../tool/mcp/config';

import { callMcpText, listServerTools, mcpToolDescriptor, namespacedToolName, sanitizeNamePart } from './shared';

/** 图床 MCP 暴露给摘要智能体的工具（有 image_tag 也收；其余工具不暴露，避免提示注入面扩大） */
const IMAGE_HOST_TOOLS: Array<{ name: string; risk: AuxToolDescriptor['risk'] }> = [
    { name: 'image_search', risk: 'read' },
    { name: 'image_keep', risk: 'write' },
    { name: 'image_unkeep', risk: 'write' },
    { name: 'image_tag', risk: 'write' },
];

/** 提示词里最多列出的最近图床图片数 */
const RECENT_HOSTED_LIMIT = 8;

export interface ImageHostAdapterDeps {
    /** 后端图床是否已配置（默认 ImageHost.enabled） */
    backendEnabled?: () => boolean;
    /** 已解析的 MCP 服务器配置（默认 getMCPServers；测试注入） */
    listMcpServers?: () => MCPServer[];
    /** 某服务器已同步的工具列表（默认 serverStates；测试注入） */
    listServerTools?: (server: string) => MCPToolDef[];
    /** 执行 MCP 工具（默认 callMCPTool 文本化；测试注入） */
    callMcp?: (server: string, tool: string, args: unknown, sessionKey: string) => Promise<string>;
    /** 图片索引（默认 ImageIndex.all；测试注入） */
    listIndex?: () => Array<{ id: string; entry: ImageIndexEntry }>;
}

/** 选出用于摘要工具的图床 MCP 服务器：优先显式 capability，其次旧的 imageRefs:true；多台取第一台 */
export function findImageHostMcpServer(servers: MCPServer[]): MCPServer | null {
    const explicit = servers.find(server => (server as { capability?: string }).capability === 'image-host');
    if (explicit) return explicit;
    return servers.find(server => server.imageRefs === true) || null;
}

/** 图床适配器的注册条件（纯函数，便于单测；不发起网络请求） */
export function shouldRegisterImageHost(deps: ImageHostAdapterDeps = {}): boolean {
    const backendEnabled = deps.backendEnabled || (() => ImageHost.enabled);
    if (backendEnabled()) return true;
    const servers = (deps.listMcpServers || getMCPServers)();
    return findImageHostMcpServer(servers) !== null;
}

export function createImageHostAdapter(deps: ImageHostAdapterDeps = {}): AuxCapabilityAdapter {
    const backendEnabled = deps.backendEnabled || (() => ImageHost.enabled);
    const listMcpServers = deps.listMcpServers || getMCPServers;
    const listTools = deps.listServerTools || listServerTools;
    const callMcp = deps.callMcp || callMcpText;
    const listIndex = deps.listIndex || (() => ImageIndex.all());

    const currentServer = (): MCPServer | null => {
        try {
            return findImageHostMcpServer(listMcpServers());
        } catch {
            return null;
        }
    };

    const toolDescriptors = (): AuxToolDescriptor[] => {
        const server = currentServer();
        if (!server) return [];
        const defs = listTools(server.name);
        const out: AuxToolDescriptor[] = [];
        for (const meta of IMAGE_HOST_TOOLS) {
            const def = defs.find(item => item && item.name === meta.name);
            if (!def) continue;
            out.push(mcpToolDescriptor(def, namespacedToolName(server.name, def.name), {
                risk: meta.risk,
                consumers: ['summarizer'],
                toolsets: ['summary-image'],
                needsContext: true,
            }));
        }
        return out;
    };

    const hostedEntries = (): Array<{ id: string; entry: ImageIndexEntry }> => {
        try {
            return listIndex().filter(item => item && item.entry && item.entry.h);
        } catch {
            return [];
        }
    };

    const buildSnippet = (): AuxSnippetDescriptor | null => {
        const server = currentServer();
        const backend = !!backendEnabled();
        if (!server && !backend) return null;
        const entries = hostedEntries()
            .slice()
            .sort((a, b) => (b.entry?.u || 0) - (a.entry?.u || 0))
            .slice(0, RECENT_HOSTED_LIMIT)
            .map(item => `h${item.entry.h}`);
        return {
            kind: 'image-host',
            data: {
                backend,
                server: server ? server.name : '',
                galleryImageCount: hostedEntries().length,
                recentHostedImages: entries,
            },
        };
    };

    return {
        id: 'image-host',
        kind: 'image-host',
        displayName: 'Image host gallery',
        tools(): AuxToolDescriptor[] {
            return toolDescriptors();
        },
        snippet(): AuxSnippetDescriptor | null {
            return buildSnippet();
        },
        handler(name: string): AuxToolHandler | null {
            const server = currentServer();
            if (!server) return null;
            const prefix = `${sanitizeNamePart(server.name)}__`;
            if (!name.startsWith(prefix)) return null;
            const rawName = name.slice(prefix.length);
            const meta = IMAGE_HOST_TOOLS.find(item => item.name === rawName);
            if (!meta) return null;
            const defs = listTools(server.name);
            if (!defs.some(item => item && item.name === rawName)) return null;
            return async (args: unknown, env): Promise<string> => {
                const sessionKey = env.context?.sessionId || '';
                let text = await callMcp(server.name, rawName, args, sessionKey);
                // 图床工具输出标准图片引用：与主链一致，把 [img:<sha>] 规范化为 [img:h<sha>]
                // （summary-image 场景模型会用这些引用继续调用 image_view/image_to_text）
                if (server.imageRefs === true || (server as { capability?: string }).capability === 'image-host') {
                    text = Image.normalizeToolText(text);
                }
                return text;
            };
        },
        /** 工具数 + 已入库（h 非空）图片数：两者变化都会影响提示词里的数量/最近 ID 列表 */
        revision(): number {
            return toolDescriptors().length + hostedEntries().length;
        },
    };
}
