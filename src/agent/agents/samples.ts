import { AgentManager } from "../agent";

const sampleAgent = AgentManager.getAgent("sample_agent");
sampleAgent.name = "sample_agent";
sampleAgent.description = "示例智能体";
sampleAgent.instruction = "你是一个示例智能体。";
AgentManager.saveAgent(sampleAgent);
export { sampleAgent };
