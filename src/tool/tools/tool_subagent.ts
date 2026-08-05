// 子智能体工具：把已注册的子智能体暴露给 AI 调用（压缩/摘要/示例等）
import Agent from "../../agent/agent";
import Tool from "../tool";

export function registerSubAgent() {
    // 只暴露实际可用的子智能体；示例智能体仅作开发示例，不进入工具列表
    const agents = ['compress_agent', 'summarize_agent'];
    const agentList = agents.join('、');

    const tool = new Tool({
        type: "function",
        function: {
            name: "call_subagent",
            description: `调用子智能体处理指定文本，返回子智能体的处理结果。可用子智能体: ${agentList}。` +
                `compress_agent 用于压缩长文本；summarize_agent 用于总结文本。`,
            parameters: {
                type: "object",
                properties: {
                    agent: {
                        type: "string",
                        description: "子智能体名称，取可用列表中的一项",
                        enum: agents
                    },
                    input: {
                        type: "string",
                        description: "要交给子智能体处理的文本内容"
                    }
                },
                required: ["agent", "input"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const { agent: agentName, input } = args;
        if (!agents.includes(agentName)) return `子智能体 ${agentName} 不存在`;
        const agent = Agent.get(agentName);
        const content = await agent.chat(input);
        return content || `子智能体 ${agentName} 未返回内容`;
    }
}
