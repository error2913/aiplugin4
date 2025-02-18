import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerFace() {
    const { localImagesTemplate } = ConfigManager.image;
    const localImages: { [key: string]: string } = localImagesTemplate.reduce((acc: { [key: string]: string }, item: string) => {
        const match = item.match(/<(.+)>.*/);
        if (match !== null) {
            const key = match[1];
            acc[key] = item.replace(/<.*>/g, '');
        }
        return acc;
    }, {});
    
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
    tool.solve = async (ctx, msg, _, name) => {
        const { localImagesTemplate } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagesTemplate.reduce((acc: { [key: string]: string }, item: string) => {
            const match = item.match(/<(.+)>.*/);
            if (match !== null) {
                const key = match[1];
                acc[key] = item.replace(/<.*>/g, '');
            }
            return acc;
        }, {});

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