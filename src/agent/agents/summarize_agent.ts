// 摘要智能体：用于总结记忆生成（use=summarization）
import Agent from "../agent";

// 摘要智能体：懒初始化（需在 Config.registerConfig 之后调用）
export function init() {
    const summarizeAgent = Agent.get("summarize_agent");
    summarizeAgent.name = "summarize_agent";
    summarizeAgent.description = "摘要智能体";
    summarizeAgent.instruction = "You are a summarization agent; you can summarize text. Write all generated text in the language of the conversation.";
    summarizeAgent.use = "summarization";
    Agent.save(summarizeAgent);
    return summarizeAgent;
}
