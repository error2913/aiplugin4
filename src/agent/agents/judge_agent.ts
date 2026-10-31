// 评分智能体：判断群聊消息是否值得机器人插话（use=judge，未单独配置 judge 模型时回退 chat 模型）
import Agent from "../agent";

// 评分智能体：懒初始化（需在 Config.registerConfig 之后调用，因为 Agent.get 依赖 ext）
export function init() {
    const judgeAgent = Agent.get("judge_agent");
    judgeAgent.name = "judge_agent";
    judgeAgent.description = "评分智能体";
    judgeAgent.instruction = "You are a group-chat interjection quality scorer; rate the current message on the six dimensions using 0..10 scores and output JSON. Do not output an action, confidence, or reason.";
    judgeAgent.use = "judge";
    Agent.save(judgeAgent);
    return judgeAgent;
}
