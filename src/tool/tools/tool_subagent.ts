// 子智能体工具：把已注册的子智能体暴露给 AI 调用（压缩/摘要/示例等）
import Agent from "../../agent/agent";
import Tool from "../tool";

export function registerSubAgent() {
    // 排除默认主智能体 '*'
    const agents = Object.keys(Agent.agentMap).filter(name => name !== '*');
    const agentList = agents.length > 0 ? agents.join('、') : 'compress_agent、summarize_agent';

    const tool = new Tool({
        type: "function",
        function: {
            name: "call_subagent",
            description: `调用子智能体处理指定文本，返回子智能体的处理结果。可用子智能体: ${agentList}。` +
                `compress_agent 用于压缩长文本；summarize_agent 用于总结文本；sample_agent 为示例智能体。`,
            parameters: {
                type: "object",
                properties: {
                    agent: {
                        type: "string",
                        description: "子智能体名称，取可用列表中的一项",
                        enum: agents.length > 0 ? agents : ['compress_agent', 'summarize_agent', 'sample_agent']
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
        const agent = Agent.get(agentName);
        if (!agent || agentName === '*') return `子智能体 ${agentName} 不存在`;
        const content = await agent.chat(input);
        return content || `子智能体 ${agentName} 未返回内容`;
    }
}
