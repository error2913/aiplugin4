import { AgentManager } from "../agent";

export function initCompressAgent() {
    const agent = AgentManager.agentMap["compress_agent"];
    agent.name = "compress_agent";
    agent.description = "压缩智能体";
    agent.instruction = "你是一个压缩智能体，你可以压缩文本。";
    AgentManager.agentMap[agent.name] = agent;
    AgentManager.saveAgent(agent);
}