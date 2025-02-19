import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerGetTime() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "get_time",
            description: `获取当前时间`,
            parameters: {
                type: "object",
                properties: {
                },
                required: []
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ___, ____) => {
        return new Date().toLocaleString();
    }

    ToolManager.toolMap[info.function.name] = tool;
}