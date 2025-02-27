import { ImageManager } from "../AI/image";
import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
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
    tool.solve = async (_, __, ai, args) => {
        const { id, content } = args;

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

export function registerCheckAvatar() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "check_avatar",
            description: `查看指定用户的头像，可指定需要特别关注的内容`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    content: {
                        type: "string",
                        description: `需要特别关注的内容`
                    }
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { name, content } = args;

        const uid = ai.context.findUserId(ctx, name);
        if (uid === null) {
            console.log(`未找到<${name}>`);
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        const url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/\D+/g, '')}&s=640`;
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        const reply = await ImageManager.imageToText(url, text);
        if (reply) {
            return reply;
        } else {
            return '头像识别失败';
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}