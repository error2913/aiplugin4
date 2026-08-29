// 打分智能体：判断群聊消息是否值得机器人插话（use=judge，未单独配置 judge 模型时回退 chat 模型）
import Agent from "../agent";

// 打分智能体：懒初始化（需在 Config.registerConfig 之后调用，因为 Agent.get 依赖 ext）
export function init() {
    const judgeAgent = Agent.get("judge_agent");
    judgeAgent.name = "judge_agent";
    judgeAgent.description = "打分智能体";
    judgeAgent.instruction = "你是一个群聊插话质量评判员，对消息进行五维打分并输出 JSON。";
    judgeAgent.use = "judge";
    Agent.save(judgeAgent);
    return judgeAgent;
}
