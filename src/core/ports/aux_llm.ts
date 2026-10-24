// 辅助 LLM 端口：压缩 / 摘要 / 记忆抽取 / 评分等「内部推理」调用方只依赖本端口。
// 运行期实现由 agent 层在组合根注册（Agent.chat / chatMessages），避免
// context / memory / judge 反向依赖 agent 主链（14 环的主要成因之一）。
// 本文件不 import 任何项目模块，属 L0 基础层。
export interface AuxLlm {
    /** 让指定用途的智能体做一次单轮推理（对应 Agent.chat(prompt)） */
    chat(agentName: string, prompt: string): Promise<string>;
    /** 多轮消息推理（对应 Agent.chatMessages(messages)） */
    chatMessages(agentName: string, messages: { role: string; content: string }[]): Promise<string>;
}

let impl: AuxLlm | null = null;

/** 由组合根注入实现（src/index.ts / scripts/test-host.ts） */
export function setAuxLlm(next: AuxLlm | null): void {
    impl = next;
}

export function getAuxLlm(): AuxLlm {
    if (!impl) throw new Error('AuxLlm 未初始化：入口需先 installAuxLlm()');
    return impl;
}

export function hasAuxLlm(): boolean {
    return impl !== null;
}
