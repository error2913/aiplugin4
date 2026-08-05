// 图片工具：图片转文字/文生图（AIDrawing）
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Image from "../../../resource/image";
import { generateId } from "../../../utils/utils";
import Tool from "../../tool";

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
                        description: `图片id，或user_avatar:用户名称` + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '') + `，或group_avatar:群聊名称` + (Config.message.SHOW_NUMBER ? '或纯数字群号' : '')
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
    toolITT.solve = async (ctx, _, session, args) => {
        const { id, content } = args;

        const image = await session.context.findImage(ctx, id);
        if (!image) return `未找到图片${id}`;
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (image.type === 'local') return '本地图片暂时无法识别';
        await image.imageToText(text);
        return image.description || '图片识别失败';
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
                    },
                    save: {
                        type: "boolean",
                        description: "是否保存图片"
                    },
                    name: {
                        type: "string",
                        description: "如果保存图片，图片的名称"
                    }
                },
                required: ['prompt', 'save', 'name']
            }
        }
    });
    toolTTI.solve = async (ctx, msg, session, args) => {
        const { prompt, negative_prompt, save, name } = args;

        const ext = seal.ext.find('AIDrawing');
        if (!ext) {
            logger.error(`未找到AIDrawing依赖`);
            return `未找到AIDrawing依赖，请提示用户安装AIDrawing依赖`;
        }

        // 切换到当前会话ai
        // 会话已由 Tool.handleToolCall 传入，直接使用 session

        const kws = ["tti", name];

        try {
            // 新版 AIDrawing
            if (globalThis.aiDrawing && typeof globalThis.aiDrawing.sendImageRequest === 'function') {
                const result = await globalThis.aiDrawing.sendImageRequest(prompt, negative_prompt);
                const img = new Image();
                img.imageId = `${name}_${generateId()}`;
                if (result.startsWith("http://") || result.startsWith("https://")) {
                    try {
                        await img.urlToBase64();
                    } catch (e) {
                        logger.error(`将图片URL转换为base64失败: ${e}`);
                        img.url = result;
                    }
                } else {
                    img.url = result;
                }

                img.format = img.format || 'unknown';
                img.description = `AI绘图<|img:${img.imageId}|>\n${prompt ? `描述: ${prompt}` : ''}\n${negative_prompt ? `不希望出现: ${negative_prompt}` : ''}`;

                if (save) session.memory.addMemory(ctx, session, [], [], kws, [img], img.description);

                return `生成成功，请使用<|img:${img.imageId}|>发送`;
            }

            // 兼容旧版 AIDrawing
            if (globalThis.aiDrawing && typeof globalThis.aiDrawing.generateImage === 'function') {
                try {
                    await globalThis.aiDrawing.generateImage(prompt, ctx, msg, negative_prompt);
                    if (save) {
                        logger.warning('旧版 AIDrawing，无法直接保存图片');
                        return `图像生成请求已发送`;
                    }
                    return `图像生成请求已发送`;
                } catch (e) {
                    logger.error(`图像生成失败：：${e}`);
                    return `图像生成失败：${e}`;
                }
            }
            logger.error('未找到可用的 AIDrawing 接口，AIDrawing插件可能存在问题');
            return `未找到可用的 AIDrawing 接口， AIDrawing插件可能存在问题`;
        } catch (e) {
            logger.error(`图像生成失败：${e}`);
            return `图像生成失败：${e}`;
        }
    }
}
