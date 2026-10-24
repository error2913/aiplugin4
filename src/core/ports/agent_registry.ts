// Agent 解析端口（叶子）：按名字取 Agent 实例，不 import Agent 运行时实现。
// 目的：context / session / memory 只需要「按名字找 Agent」，不应因此反向依赖 agent 主链
//（这是 14 环里的多条反向边来源）。
// 实现由 agent 层在模块加载时注册为 `(name) => Agent.get(name)`：
// 这样既保留改造前 Agent.get 的懒加载语义，也让既有测试/仿真里对 `Agent.get` 的桩继续生效。
import type Agent from "../../agent/agent";

type AgentResolver = (name: string) => Agent;
let resolver: AgentResolver | null = null;

/** 由 agent 层在模块加载时注册（见 src/agent/agent.ts 末尾） */
export function setAgentResolver(fn: AgentResolver | null): void {
    resolver = fn;
}

/** 取 Agent（语义等同改造前的 Agent.get）；解析器未注册时抛明确错误 */
export function getAgent(name: string): Agent {
    if (!resolver) throw new Error('Agent 解析器未注册：请确保入口加载了 src/agent/agent');
    return resolver(name);
}
