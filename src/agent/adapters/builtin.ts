// 内置工具适配器（L3）：把本仓库工具注册表里的「只读工具」暴露给摘要智能体。
// 记忆写工具默认不给（方案 §10.1 明确不做删除类工具）；schema 直接取已注册工具的定义，
// 保证模型看到的参数说明与主链完全一致（不在适配器里另写一份 schema）。
//
// 执行：走现有 tool registry 的 Tool.solve（不是 executor）——executor 的签名要求真实
// seal.MsgContext/Message 与 Session（platformOf(ctx)/sessionType 判定在入口无条件执行），
// 摘要场景没有 QQ 消息上下文；这里由 invoker 负责参数校验/超时/截断，工具自身负责错误文案。
import type { AuxCapabilityAdapter, AuxToolDescriptor, AuxToolEnv, AuxToolHandler } from '../../core/ports/aux_tools';
import type { Session } from '../../session/session';
import { getTool } from '../../tool/registry';
import type Tool from '../../tool/tool';

/** 内置工具的辅助元数据（顺序固定；name 必须是真实注册名） */
interface BuiltinToolMeta {
    name: string;
    risk: AuxToolDescriptor['risk'];
    consumers: AuxToolDescriptor['consumers'];
    toolsets: AuxToolDescriptor['toolsets'];
    needsContext: boolean;
    /** 工具未注册时的兜底描述（注册后以 toolInfo 为准） */
    fallbackDescription: string;
    fallbackParameters: Record<string, unknown>;
}

const BUILTIN_TOOLS: BuiltinToolMeta[] = [
    {
        name: 'memory_recall',
        risk: 'read',
        consumers: ['summarizer'],
        toolsets: ['summary-memory-read'],
        needsContext: true,
        fallbackDescription: 'Retrieve long-term memory (personal/group/bot). Returns only relevant facts and observations.',
        fallbackParameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Query/keywords; empty lists recent important memories' },
                memory_scope: { type: 'string', enum: ['user', 'group', 'global'] },
                target_id: { type: 'string' },
                topK: { type: 'number' },
                keywords: { type: 'array', items: { type: 'string' } },
            },
            required: [],
        },
    },
    {
        name: 'image_view',
        risk: 'read',
        consumers: ['summarizer'],
        toolsets: ['summary-image'],
        needsContext: false,
        fallbackDescription: 'View image content directly (falls back to a text description for non-multimodal models).',
        fallbackParameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                ids: { type: 'array', items: { type: 'string' } },
                detail: { type: 'string' },
            },
            required: [],
        },
    },
    {
        name: 'image_to_text',
        risk: 'read',
        consumers: ['summarizer'],
        toolsets: ['summary-image'],
        needsContext: false,
        fallbackDescription: 'View image content and return a text description.',
        fallbackParameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                ids: { type: 'array', items: { type: 'string' } },
                content: { type: 'string' },
            },
            required: [],
        },
    },
    {
        name: 'list_resources',
        risk: 'read',
        consumers: ['summarizer'],
        toolsets: ['summary-image'],
        needsContext: false,
        fallbackDescription: 'List currently configured local resource names (images/audio/files/videos).',
        fallbackParameters: {
            type: 'object',
            properties: { type: { type: 'string', enum: ['all', 'image', 'audio', 'file', 'video'] } },
            required: [],
        },
    },
];

export interface BuiltinAdapterDeps {
    /** 取工具实例（默认走 tool/registry；单测注入替身） */
    getTool?: (name: string) => Tool | undefined;
}

/** 工具执行结果里的图片块不交给辅助模型（aux 默认不解析图片），转成明确占位文本 */
function solveResultText(solved: string | { text: string }): string {
    if (typeof solved === 'string') return solved;
    const text = String(solved?.text || '');
    return text;
}

export function createBuiltinAdapter(deps: BuiltinAdapterDeps = {}): AuxCapabilityAdapter {
    const resolveTool = deps.getTool || ((name: string) => getTool(name));

    return {
        id: 'builtin',
        kind: 'builtin',
        displayName: 'Built-in tools',
        tools(): AuxToolDescriptor[] {
            const out: AuxToolDescriptor[] = [];
            for (const meta of BUILTIN_TOOLS) {
                const tool = resolveTool(meta.name);
                // 未注册的工具不暴露给模型（避免模型看到不存在的工具反复试错；schema 以真实注册为准）
                if (!tool) continue;
                const fn = tool.toolInfo?.function;
                out.push({
                    name: meta.name,
                    description: String(fn?.description || meta.fallbackDescription).slice(0, 1000),
                    parameters: (fn?.parameters as unknown as Record<string, unknown> | undefined) || meta.fallbackParameters,
                    risk: meta.risk,
                    consumers: meta.consumers,
                    toolsets: meta.toolsets,
                    needsContext: meta.needsContext,
                });
            }
            return out;
        },
        handler(name: string): AuxToolHandler | null {
            const meta = BUILTIN_TOOLS.find(item => item.name === name);
            if (!meta) return null;
            const tool = resolveTool(name);
            // 工具未注册时不给执行句柄：tools() 也不会暴露它，保持「看到即能调用」
            if (!tool) return null;
            return async (args: unknown, env: AuxToolEnv): Promise<string> => {
                if (meta.needsContext && !env.session) {
                    // 不伪造 session：没有真实会话时明确告诉模型该能力不可用（invoker 通常已隐藏该工具）
                    return `Tool "${name}" needs a real session context and is unavailable in this auxiliary call.`;
                }
                const argsObject = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
                try {
                    // ctx/msg 传 undefined：这些只读工具不读它们（memory_recall 只读 session 的 bank/权限，
                    // image_view/image_to_text/list_resources 完全不读 ctx）；executor 因要求真实 seal ctx 不适用。
                    const solved = await tool.solve(undefined as never, undefined as never, env.session as Session, argsObject as never);
                    return solveResultText(solved as string | { text: string });
                } catch (e) {
                    return `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`;
                }
            };
        },
        /** 无提示词片段（内置工具只在摘要侧使用），修订号恒为 0，避免无谓使 prompt 缓存失效 */
        revision(): number {
            return 0;
        },
    };
}
