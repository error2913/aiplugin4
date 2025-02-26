import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerRecord() {
    const { recordsTemplate } = ConfigManager.tool;
    const records: { [key: string]: string } = recordsTemplate.reduce((acc: { [key: string]: string }, item: string) => {
        const match = item.match(/<(.+)>.*/);
        if (match !== null) {
            const key = match[1];
            acc[key] = item.replace(/<.*>/g, '');
        }
        return acc;
    }, {});

    if (Object.keys(records).length === 0) {
        return;
    }

    const info: ToolInfo = {
        type: "function",
        function: {
            name: "record",
            description: `发送语音，语音名称有:${Object.keys(records).join("、")}`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "语音名称"
                    }
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
        const { name } = args;

        if (records.hasOwnProperty(name)) {
            seal.replyToSender(ctx, msg, `[语音:${records[name]}]`);
            return '发送成功';
        } else {
            console.error(`本地语音${name}不存在`);
            return `本地语音${name}不存在`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}