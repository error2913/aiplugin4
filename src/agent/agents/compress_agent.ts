// 压缩智能体：用于压缩过长的用户消息（use=compression）
import Agent from "../agent";

// 压缩智能体：懒初始化（需在 Config.registerConfig 之后调用，因为 Agent.get 依赖 ext）
export function init() {
    const compressAgent = Agent.get("compress_agent");
    compressAgent.name = "compress_agent";
    compressAgent.description = "压缩智能体";
    compressAgent.instruction = "你是一个压缩智能体，你可以压缩文本。";
    compressAgent.use = "compression";
    Agent.save(compressAgent);
    return compressAgent;
}
