import Agent from "../agent";

const compressAgent = Agent.get("compress_agent");
compressAgent.name = "compress_agent";
compressAgent.description = "压缩智能体";
compressAgent.instruction = "你是一个压缩智能体，你可以压缩文本。";
compressAgent.use = "compression";
Agent.save(compressAgent);
export default compressAgent;
