// 示例智能体：示例命令展示用（use=chat）
import Agent from "../agent";

// 示例智能体：懒初始化（需在 Config.registerConfig 之后调用）
export function init() {
    const sampleAgent = Agent.get("sample_agent");
    sampleAgent.name = "sample_agent";
    sampleAgent.description = "示例智能体";
    sampleAgent.instruction = "你是一个示例智能体。";
    sampleAgent.use = "chat";
    Agent.save(sampleAgent);
    return sampleAgent;
}
