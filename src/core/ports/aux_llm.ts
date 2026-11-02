// 辅助 LLM 端口：摘要 / 记忆抽取 / 评分等「内部推理」调用方只依赖本端口。
// 运行期实现由 agent 层在组合根注册（Agent.chat / chatMessages），避免
// context / memory / judge 反向依赖 agent 主链（14 环的主要成因之一）。
// 本文件不 import 任何项目模块，属 L0 基础层。
export interface AuxLlm {
    /**
     * 让指定用途的智能体做一次单轮推理（对应 Agent.chat(prompt)）。
     * `throwClassified: true` 时把模型分类错误（ApiError）上抛给调用方，
     * 由调用方决定熔断/退避；缺省维持既有「吞错返回空串」语义。
     */
    chat(agentName: string, prompt: string, opts?: { throwClassified?: boolean }): Promise<string>;
    /** 多轮消息推理（对应 Agent.chatMessages(messages)） */
    chatMessages(agentName: string, messages: { role: string; content: string }[], opts?: { throwClassified?: boolean }): Promise<string>;
    /**
     * 指定用途是否已配置可用模型（判定降级用：未配置 ⇒ 纯规则保守发言）。
     * 可选方法：测试桩/裁剪场景未实现时视为「有模型」，保持既有桩语义。
     */
    hasModel?(agentName: string): Promise<boolean>;
    /**
     * judge 当前模型是普通聊天模型还是 System One 决策模型（judge 按此选择 messages / state+questions）。
     * 可选方法：测试桩缺省按 'chat' 处理。
     */
    modelKind?(agentName: string): Promise<'chat' | 'decision'>;
    /**
     * System One 决策调用（judge 专用）；返回原始响应，由 judge 归一化。
     * 可选方法：测试桩缺省视为不可用（judge 记失败并 WAIT）。
     */
    systemOne?(agentName: string, state: unknown, questions: Record<string, unknown>): Promise<unknown>;
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
