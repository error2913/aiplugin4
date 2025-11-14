import { ImageManager } from "../AI/image";
import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";

export function registerImage() {
    const toolITT = new Tool({
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
    });
    toolITT.solve = async (ctx, _, ai, args) => {
        const { id, content } = args;

        const image = ai.context.findImage(ctx, id);
        if (!image) return { content: `未找到图片${id}`, images: [] };
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (image.isUrl) {
            const reply = await ImageManager.imageToText(image.file, text);
            if (reply) {
                return { content: reply, images: [] };
            } else {
                return { content: '图片识别失败', images: [] };
            }
        } else {
            return { content: '本地图片暂时无法识别', images: [] };
        }
    }

    const toolAvatar = new Tool({
        type: "function",
        function: {
            name: "check_avatar",
            description: `查看指定用户的头像，可指定需要特别关注的内容`,
            parameters: {
                type: "object",
                properties: {
                    avatar_type: {
                        type: "string",
                        description: "头像类型，个人头像或群聊头像",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与头像类型对应'
                    },
                    content: {
                        type: "string",
                        description: `需要特别关注的内容`
                    }
                },
                required: ["avatar_type", "name"]
            }
        }
    });
    toolAvatar.solve = async (ctx, _, ai, args) => {
        const { avatar_type, name, content = '' } = args;

        let url = '';
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (avatar_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/^.+:/, '')}&s=640`;
        } else if (avatar_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            url = `https://p.qlogo.cn/gh/${gid.replace(/^.+:/, '')}/${gid.replace(/^.+:/, '')}/640`;
        } else {
            return { content: `未知的头像类型<${avatar_type}>`, images: [] };
        }


        const reply = await ImageManager.imageToText(url, text);
        if (reply) {
            return { content: reply, images: [] };
        } else {
            return { content: '头像识别失败', images: [] };
        }
    }

    const toolTTI = new Tool({
        type: 'function',
        function: {
            name: 'text_to_image',
            description: '通过文字描述生成图像',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: '图像描述'
                    },
                    negative_prompt: {
                        type: 'string',
                        description: '不希望图片中出现的内容描述'
                    }
                },
                required: ['prompt']
            }
        }
    });
    toolTTI.solve = async (ctx, msg, _, args) => {
        const { prompt, negative_prompt } = args;

        const ext = seal.ext.find('AIDrawing');
        if (!ext) {
            logger.error(`未找到AIDrawing依赖`);
            return { content: `未找到AIDrawing依赖，请提示用户安装AIDrawing依赖`, images: [] };
        }

        try {
            await globalThis.aiDrawing.generateImage(prompt, ctx, msg, negative_prompt);
            return { content: `图像生成请求已发送`, images: [] };
        } catch (e) {
            logger.error(`图像生成失败：${e}`);
            return { content: `图像生成失败：${e}`, images: [] };
        }
    }
}