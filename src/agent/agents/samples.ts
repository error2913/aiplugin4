// 示例智能体：示例命令展示用（use=chat）
import Agent from "../agent";

const sampleAgent = Agent.get("sample_agent");
sampleAgent.name = "sample_agent";
sampleAgent.description = "示例智能体";
sampleAgent.instruction = "你是一个示例智能体。";
sampleAgent.use = "chat";
Agent.save(sampleAgent);
export default sampleAgent;
