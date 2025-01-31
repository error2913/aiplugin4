import { ConfigManager } from "../utils/configUtils";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerFace() {
    const { localImages } = ConfigManager.getLocalImageConfig();
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "face",
            description: `发送表情包，表情名称有:${Object.keys(localImages).length === 0 ? '暂无表情' : Object.keys(localImages).join("、")}`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "表情名称"
                    }
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, __, name) => {
        if (!name) {
            console.error(`发送表情需要一个表情名称`);
            return `发送表情需要一个表情名称`;
        }

        const { localImages } = ConfigManager.getLocalImageConfig();
        if (localImages.hasOwnProperty(name)) {
            seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[name]}]`);
            return '发送成功';
        } else {
            console.error(`本地图片${name}不存在`);
            return `本地图片${name}不存在`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}