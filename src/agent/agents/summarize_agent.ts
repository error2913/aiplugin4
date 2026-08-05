// 摘要智能体：用于短期记忆总结（use=summarization）
import Agent from "../agent";

// 摘要智能体：懒初始化（需在 Config.registerConfig 之后调用）
export function init() {
    const summarizeAgent = Agent.get("summarize_agent");
    summarizeAgent.name = "summarize_agent";
    summarizeAgent.description = "摘要智能体";
    summarizeAgent.instruction = "你是一个摘要智能体，你可以摘要文本。";
    summarizeAgent.use = "summarization";
    Agent.save(summarizeAgent);
    return summarizeAgent;
}
