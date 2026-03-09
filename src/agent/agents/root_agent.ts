import Agent from "../agent";

const rootAgent = Agent.get("root_agent");
rootAgent.name = "root_agent";
rootAgent.description = "根智能体";
rootAgent.instruction = "你是一个根智能体，你可以调用其他智能体。";
rootAgent.use = "chat";
Agent.save(rootAgent);
export { rootAgent };