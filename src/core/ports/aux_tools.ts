// 辅助智能体工具端口（L0）：辅助调用（摘要等）与主对话提示词段只依赖这里的「元数据 + 注册表」，
// 不 import 任何工具/图床/MCP/resource 实现，避免 prompt/agent/memory 之间再长出反向依赖。
//
// 结构（方案 v1.4 §10.2）：
//   数据源（内置工具 / 内置图片索引 / 图床 MCP / 任意 MCP / 本地资源）
//     → L3 适配器（adapters/*，唯一知道来源细节，负责 tools()/snippet()/handler()/revision()）
//     → L0 注册表（本文件，只做聚合/过滤）
//     → L3 invoker（aux_agent_impl，通用执行：参数校验/超时/截断）
//
// 本文件只放类型与注册表，**不 import 任何项目模块**（L0 约束，deps 规则同 core/**）。
// 适配器实现见 src/agent/adapters/*，装配见 src/agent/aux_tools_impl.ts。

/** 消费方：main = 主对话（只取提示词片段，不取工具）；summarizer = 摘要智能体（只取工具） */
export type AuxConsumer = 'main' | 'summarizer';

/** 风险等级：摘要智能体默认只给 read；write 需显式进 toolset；dangerous 默认不给 */
export type AuxRisk = 'read' | 'write' | 'dangerous';

/** 摘要智能体工具集：按场景挂载（summary-image 仅在待摘要内容含图片引用时启用） */
export type AuxToolset = 'summary-image' | 'summary-memory-read';

/** 单个可暴露工具的元数据（执行句柄由适配器的 handler(name) 提供） */
export interface AuxToolDescriptor {
    name: string;
    description: string;
    /** JSON Schema（OpenAI function.parameters 口径） */
    parameters: Record<string, unknown>;
    risk: AuxRisk;
    /** 允许调用该工具的消费方 */
    consumers: AuxConsumer[];
    /** 归属工具集；空数组 = 默认不进任何 toolset（如通用 MCP 工具） */
    toolsets: AuxToolset[];
    /** 是否依赖会话上下文（无 ctx/session 时调用方应隐藏该工具） */
    needsContext: boolean;
}

/** 提示词片段：结构化数据，最终文案由 prompt 段渲染（适配器不写文案） */
export interface AuxSnippetDescriptor {
    kind: 'image-host' | 'resource';
    data: Record<string, string | number | boolean | string[]>;
}

/** 工具执行环境：context 为调用方给定的会话元信息；session 由 invoker 按 context 解析后注入 */
export interface AuxToolEnv {
    context?: { sessionId: string; isPrivate: boolean; epId?: string };
    session?: unknown;
}

/** 工具执行句柄：入参是模型给的参数对象，返回可回填给模型的文本 */
export type AuxToolHandler = (args: unknown, env: AuxToolEnv) => Promise<string>;

/** 能力适配器：每个数据来源一个；适配器只做「元数据 + 执行句柄」，不写 UI/文案 */
export interface AuxCapabilityAdapter {
    id: string;
    kind: 'builtin' | 'image-host' | 'mcp' | 'resource';
    displayName: string;
    /** 初始化钩子（可选；注册时不强制 await，避免阻塞启动） */
    init?(): Promise<void>;
    tools(): AuxToolDescriptor[];
    /** 提示词片段（可选）；返回 null 表示当前无可用内容 */
    snippet?(): AuxSnippetDescriptor | null;
    /** 按暴露给模型的工具名取执行句柄；不属于本适配器返回 null */
    handler(name: string): AuxToolHandler | null;
    /** 数据变化签名（供 prompt 缓存）；同一数据必须返回同一值 */
    revision(): number;
}

/** 注册表只读视图（端口）：消费方/提示词段只依赖这 4 个方法 */
export interface AuxToolRegistry {
    /** 某消费方可见的工具 + 提示词片段；toolset 给定时只取归属该 toolset 的工具 */
    viewFor(consumer: AuxConsumer, toolset?: AuxToolset): { tools: AuxToolDescriptor[]; snippets: AuxSnippetDescriptor[] };
    hasSnippet(kind: AuxSnippetDescriptor['kind']): boolean;
    revision(): number;
}

/**
 * 注册表实现：适配器注册/注销 + 聚合过滤。
 * 不缓存 tools()/snippet()：适配器数据源会随配置（≤60s）、MCP 热同步、图片索引变化，
 * 缓存住动态 ID 列表会与实际不一致（方案 §10.5 明确不允许缓存动态 ID）。
 */
export class AuxToolRegistryImpl implements AuxToolRegistry {
    private readonly adapters = new Map<string, AuxCapabilityAdapter>();

    /** 注册适配器（同 id 重复注册视为装配 bug，直接抛错） */
    register(adapter: AuxCapabilityAdapter): void {
        if (!adapter || !adapter.id) throw new Error('Aux 适配器缺少 id');
        if (this.adapters.has(adapter.id)) throw new Error(`Aux 适配器重复注册：${adapter.id}`);
        this.adapters.set(adapter.id, adapter);
    }

    /** 注销适配器（未注册时静默，便于降级路径重复调用） */
    unregister(id: string): void {
        this.adapters.delete(id);
    }

    /** 清空全部适配器（测试/重载用） */
    clear(): void {
        this.adapters.clear();
    }

    /** 当前适配器（测试/诊断用；外部请用 viewFor/hasSnippet/revision） */
    list(): AuxCapabilityAdapter[] {
        return Array.from(this.adapters.values());
    }

    /**
     * 消费方视图：
     * - 工具按 consumers 过滤；给定 toolset 时再按 toolsets 过滤；
     * - 提示词片段只给主对话（摘要/判定不注入标签，方案 §10.5）；
     * - 适配器抛错不影响其它来源（降级时少一个来源而已）。
     */
    viewFor(consumer: AuxConsumer, toolset?: AuxToolset): { tools: AuxToolDescriptor[]; snippets: AuxSnippetDescriptor[] } {
        const tools: AuxToolDescriptor[] = [];
        const snippets: AuxSnippetDescriptor[] = [];
        for (const adapter of this.adapters.values()) {
            try {
                for (const tool of adapter.tools()) {
                    if (!tool || !Array.isArray(tool.consumers) || !tool.consumers.includes(consumer)) continue;
                    if (toolset && !(Array.isArray(tool.toolsets) && tool.toolsets.includes(toolset))) continue;
                    tools.push(tool);
                }
                if (consumer === 'main' && adapter.snippet) {
                    const snippet = adapter.snippet();
                    if (snippet) snippets.push(snippet);
                }
            } catch {
                // 单个适配器失败只丢该来源：主对话仍有内置说明，摘要可继续（方案 §10.7）
            }
        }
        // 固定顺序：先按工具名排序，保证提示词/工具 schema 稳定（不依赖注册顺序）
        tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { tools, snippets };
    }

    /** 是否存在某类提示词片段（builder 用它派生 imageHost，不再直接判 ImageHost/MCP） */
    hasSnippet(kind: AuxSnippetDescriptor['kind']): boolean {
        return this.snippet(kind) !== null;
    }

    /** 取某类提示词片段（prompt 段渲染动态数据用；不存在返回 null） */
    snippet(kind: AuxSnippetDescriptor['kind']): AuxSnippetDescriptor | null {
        for (const adapter of this.adapters.values()) {
            if (!adapter.snippet) continue;
            try {
                const snippet = adapter.snippet();
                if (snippet && snippet.kind === kind) return snippet;
            } catch {
                // 单来源失败按无片段处理
            }
        }
        return null;
    }

    /** 工具名 → 执行句柄（invoker 用；跨适配器按名字查找，同名前者优先） */
    handler(name: string): AuxToolHandler | null {
        for (const adapter of this.adapters.values()) {
            try {
                const handler = adapter.handler(name);
                if (handler) return handler;
            } catch {
                // 单来源查找失败继续看下一个
            }
        }
        return null;
    }

    /** 全部工具名（诊断/审计用） */
    toolNames(): string[] {
        return this.viewFor('summarizer').tools.map(tool => tool.name);
    }

    /**
     * 聚合数据修订号：适配器 revision 的稳定组合（顺序无关），供 prompt 段缓存依赖。
     * 用乘 31 的滚动哈希而不是求和：避免两个来源一增一减时签名恰好不变。
     */
    revision(): number {
        const entries = Array.from(this.adapters.values())
            .map(adapter => {
                let rev = 0;
                try {
                    rev = Math.floor(adapter.revision() || 0);
                } catch {
                    rev = 0;
                }
                return `${adapter.id}:${rev}`;
            })
            .sort();
        let hash = 0x811c9dc5;
        for (const entry of entries) {
            for (let i = 0; i < entry.length; i++) {
                hash ^= entry.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
        }
        return hash;
    }
}

/** 默认单例：prompt 段与 builder 直接读它；适配器由组合根 installAuxTools() 注册 */
export const auxRegistry = new AuxToolRegistryImpl();

/** 测试用：清空默认注册表（避免用例间互相污染；生产重载前也可调用） */
export function resetAuxRegistryForTest(): void {
    auxRegistry.clear();
}
