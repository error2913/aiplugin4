// 示例智能体：仅作开发参考，不参与运行时初始化（未在 initAgents 中调用）
import Agent from "../agent";

// 示例智能体：如需启用请手动调用 init()，默认不进入实际使用
export function init() {
    const sampleAgent = Agent.get("sample_agent");
    sampleAgent.name = "sample_agent";
    sampleAgent.description = "示例智能体";
    sampleAgent.instruction = "你是一个示例智能体。";
    sampleAgent.use = "chat";
    Agent.save(sampleAgent);
    return sampleAgent;
}
