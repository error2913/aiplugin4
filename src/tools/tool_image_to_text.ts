import { ImageManager } from "../AI/image";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerImageToText() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "image_to_text",
            description: `查看图片中的内容，可指定需要特别关注的内容`,
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: `图片的id，六位字符`
                    },
                    content: {
                        type: "string",
                        description: `需要特别关注的内容`
                    }
                },
                required: ["id"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ai, id, content) => {
        const image = ai.context.findImage(id);
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (image.isUrl) {
            const reply = await ImageManager.imageToText(image.file, text);
            if (reply) {
                return reply;
            } else {
                return '图片识别失败';
            }
        } else {
            return '本地图片暂时无法识别';
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}