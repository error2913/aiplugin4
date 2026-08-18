// 图片工具：图片转文字/文生图（tti）
import { logger } from "../../../logger";
import Image from "../../../resource/image";
import { generateId } from "../../../utils/utils";
import Tool from "../../tool";

async function resolveTtiImage(ctx: seal.MsgContext, session: any, raw: string): Promise<string | null> {
    let input = String(raw || '').trim();
    if (!input) return null;

    const tagMatch = input.match(/^[[［]img[:：]\s?([^\]］]+)[\]］]$/i);
    if (tagMatch) input = tagMatch[1].trim();

    if (/^data:/i.test(input) || /^https?:\/\//i.test(input)) return input;

    // 直接传入 base64 时原样返回；长度阈值用于避免把普通图片 ID 误判为 base64。
    const compact = input.replace(/\s+/g, '');
    if (compact.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(compact)) return input;

    const image = await session.context.findImage(ctx, input)
        || (input.includes(':') ? await session.context.findImage(ctx, input.split(':')[0]) : null);
    if (!image) return null;
    if (image.type === 'local') return null;

    if (image.type === 'url') {
        try {
            await image.urlToBase64();
        } catch (e) {
            logger.warning(`参考图URL转base64失败: ${e}`);
        }
        return image.base64 ? image.base64Url : image.src;
    }

    return image.base64Url;
}

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
                        description: '图片ID，或user_avatar:用户ID，或group_avatar:群ID'
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
                    },
                    image: {
                        type: "string",
                        description: "可选参考图，用于以图生图。支持图片ID、user_avatar:用户ID、group_avatar:群ID、http(s)图片URL、data:image/...;base64或base64数据"
                    }
                },
                required: ['prompt', 'save', 'name']
            }
        }
    });
    toolTTI.solve = async (ctx, msg, session, args) => {
        const { prompt, negative_prompt, save, name, image } = args;

        const ext = seal.ext.find('tti');
        if (!ext) {
            logger.error(`未找到生成图片依赖（tti）`);
            return `未找到生成图片依赖（tti），请提示用户安装生成图片依赖`;
        }

        // 切换到当前会话ai
        // 会话已由 Tool.handleToolCall 传入，直接使用 session

        const kws = ["tti", name];

        try {
            // tti 统一 API
            if (globalThis.tti && typeof globalThis.tti.generate === 'function') {
                const request: { text: string; negativeText?: string; image?: string } = { text: prompt };
                if (negative_prompt) request.negativeText = negative_prompt;
                if (image) {
                    const reference = await resolveTtiImage(ctx, session, image);
                    if (!reference) return `未找到参考图${image}`;
                    request.image = reference;
                }

                const result = await globalThis.tti.generate(request);
                if (!result.success) throw new Error(result.error || '图像生成失败');
                const img = new Image();
                img.imageId = `${name}_${generateId()}`;
                if (result.data.startsWith("http://") || result.data.startsWith("https://")) {
                    img.url = result.data;
                    try {
                        await img.urlToBase64();
                    } catch (e) {
                        logger.error(`将图片URL转换为base64失败: ${e}`);
                    }
                } else {
                    // tti 依赖可能返回带 data:image/...;base64 前缀的字符串，统一剥离后再存
                    img.base64 = /^data:/i.test(result.data) && result.data.includes(',')
                        ? result.data.slice(result.data.indexOf(',') + 1)
                        : result.data;
                }

                img.format = img.format || 'unknown';
                img.description = `AI绘图[img:${img.imageId}]\n${prompt ? `描述: ${prompt}` : ''}\n${negative_prompt ? `不希望出现: ${negative_prompt}` : ''}\n${image ? `参考图: 已提供` : ''}`;

                if (save) session.memory.addMemory(ctx, session, [], [], kws, [img], img.description);

                return `生成成功，请使用[img:${img.imageId}]发送`;
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
            logger.error('未找到可用的 tti 接口，生成图片插件可能存在问题');
            return `未找到可用的 tti 接口，生成图片插件可能存在问题`;
        } catch (e) {
            logger.error(`图像生成失败：${e}`);
            return `图像生成失败：${e}`;
        }
    }
}
