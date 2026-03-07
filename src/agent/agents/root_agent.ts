import { AgentManager } from "../agent";

export function initRootAgent() {
    const agent = AgentManager.agentMap["root_agent"];
    agent.name = "root_agent";
    agent.description = "根智能体";
    agent.instruction = "你是一个根智能体，你可以调用其他智能体。";
    AgentManager.agentMap[agent.name] = agent;
    AgentManager.saveAgent(agent);
}