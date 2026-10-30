// 辅助智能体端口（L0）：摘要等内部推理只依赖「能跑一次带工具的辅助调用」这一契约，
// 不 import agent/stream/tool/mcp；实现由组合根在 agent 层注册（src/agent/aux_agent_impl.ts）。
//
// 为什么不扩 AuxLlm：AuxLlm 是「一次单轮推理」，带工具循环属于另一种生命周期，
// 混在一起会让 memory/context/judge 的既有调用方被迫理解工具语义（方案 v1.4 §10.3）。
import type { AuxToolset } from './aux_tools';

/** runWithTools 的运行参数 */
export interface AuxAgentRunOptions {
    /** 工具集：摘要场景按内容挂载（summary-image / summary-memory-read） */
    toolset: AuxToolset;
    /** 最多工具轮数（缺省 3） */
    maxRounds?: number;
    /** 总超时（秒，缺省 30） */
    timeoutSec?: number;
    /** 输入消息的 token 预算（0/缺省 = 不额外裁剪，由调用方负责） */
    tokenBudget?: number;
    /** 会话元信息；缺省时 needsContext 工具会被隐藏（不伪造 session） */
    context?: { sessionId: string; isPrivate: boolean; epId?: string };
}

/** 辅助智能体端口：原生 tool_calls 循环 + 工具执行，返回最终文本 */
export interface AuxAgent {
    runWithTools(agentName: string, messages: { role: string; content: string }[], opts: AuxAgentRunOptions): Promise<string>;
}

let impl: AuxAgent | null = null;

/** 由组合根注入实现（src/agent/aux_agent_impl.ts 的 installAuxAgent） */
export function setAuxAgent(next: AuxAgent | null): void {
    impl = next;
}

/** 取实现；未注册时抛明确错误（与 AuxLlm 端口同一口径） */
export function getAuxAgent(): AuxAgent {
    if (!impl) throw new Error('AuxAgent 未初始化：入口需先 installAuxAgent()');
    return impl;
}

export function hasAuxAgent(): boolean {
    return impl !== null;
}
