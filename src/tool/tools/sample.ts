import { Tool } from "../tool";

const toolSample = new Tool({
    type: "function",
    function: {
        name: "sample",
        description: `示例工具`,
        parameters: {
            type: "object",
            properties: {
                arg: {
                    type: 'string',
                    description: '参数'
                }
            },
            required: ["arg"]
        }
    }
});
toolSample.solve = async (ctx, msg, agent, args) => {
    const { arg } = args;
    arg; ctx; msg; agent;
    return "调用示例函数成功";
}

export { toolSample };