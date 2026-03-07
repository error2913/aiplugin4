import { Tool } from "./tool";

export function registerSample() {
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
    tool.solve = async (ctx, msg, ai, args) => {
        const { arg } = args;
        arg; ctx; msg; ai;
        return { content: "调用成功", images: [] };
    }
}