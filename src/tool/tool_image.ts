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
                        description: `图片id，或user_avatar:用户名称` + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '') + `，或group_avatar:群聊名称` + (ConfigManager.message.showNumber ? '或纯数字群号' : '')
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

        const image = await ai.context.findImage(ctx, id);
        if (!image) return { content: `未找到图片${id}`, images: [] };
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (image.type === 'local') return { content: '本地图片暂时无法识别', images: [] };
        await image.imageToText(text);
        return { content: image.content || '图片识别失败', images: [] };
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

// TODO: tti改为返回图片base64
// 注意兼容问题