import { AgentManager } from "../agent";

const compressAgent = AgentManager.getAgent("compress_agent");
compressAgent.name = "compress_agent";
compressAgent.description = "压缩智能体";
compressAgent.instruction = "你是一个压缩智能体，你可以压缩文本。";
AgentManager.saveAgent(compressAgent);
export { compressAgent };
