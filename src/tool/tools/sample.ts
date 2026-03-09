import { Tool } from "../tool";

const tool = new Tool({
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
tool.solve = async (ctx, msg, session, args) => {
    const { arg } = args;
    arg; ctx; msg; session;
    return "调用示例函数成功";
}

export { tool as toolSample };