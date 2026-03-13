import Agent from "../agent";

const summarizeAgent = Agent.get("summarize_agent");
summarizeAgent.name = "summarize_agent";
summarizeAgent.description = "摘要智能体";
summarizeAgent.instruction = "你是一个摘要智能体，你可以摘要文本。";
summarizeAgent.use = "summarization";
Agent.save(summarizeAgent);
export default summarizeAgent;
