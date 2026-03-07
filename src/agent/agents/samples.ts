import { AgentManager } from "../agent";

export function initSampleAgent() {
    const agent = AgentManager.agentMap["sample_agent"];
    agent.name = "sample_agent";
    agent.description = "示例智能体";
    agent.instruction = "你是一个示例智能体。";
    AgentManager.agentMap[agent.name] = agent;
    AgentManager.saveAgent(agent);
}