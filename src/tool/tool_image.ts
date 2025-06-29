import { ImageManager } from "../AI/image";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
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

        const image = ai.context.findImage(id, ai);
        if (!image) {
            return `未找到图片${id}`;
        }
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
        const { avatar_type, name, content = '' } = args;

        let url = '';
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (avatar_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return `未找到<${name}>`;
            }

            url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/^.+:/, '')}&s=640`;
        } else if (avatar_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return `未找到<${name}>`;
            }

            url = `https://p.qlogo.cn/gh/${gid.replace(/^.+:/, '')}/${gid.replace(/^.+:/, '')}/640`;
        } else {
            return `未知的头像类型<${avatar_type}>`;
        }


        const reply = await ImageManager.imageToText(url, text);
        if (reply) {
            return reply;
        } else {
            return '头像识别失败';
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerTextToImage() {
    const info: ToolInfo = {
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
    };

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
        const { prompt, negative_prompt } = args;

        const ext = seal.ext.find('AIDrawing');
        if (!ext) {
            logger.error(`未找到AIDrawing依赖`);
            return `未找到AIDrawing依赖，请提示用户安装AIDrawing依赖`;
        }

        try {
            await globalThis.aiDrawing.generateImage(prompt, ctx, msg, negative_prompt);
            return `图像生成请求已发送`;
        } catch (e) {
            logger.error(`图像生成失败：${e}`);
            return `图像生成失败：${e}`;
        }
    };

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerSaveImage() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "save_image",
            description: "将图片保存为表情包",
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: `图片的id，六位字符`
                    },
                    name: {
                        type: "string",
                        description: `图片命名`
                    },
                    scene: {
                        type: "string",
                        description: `表情包的应用场景`
                    }
                },
                required: ["id", "name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ai, args) => {
        const { id, name, scene } = args;

        const image = ai.context.findImage(id, ai);
        if (!image) {
            return `未找到图片${id}`;
        }

        if (image.isUrl) {
            const { base64 } = await ImageManager.imageUrlToBase64(image.file);
            if (!base64) {
                logger.warning(`转换为base64失败`);
                return '转换为base64失败';
            }

            try {
                const finalName = ai.image.updateSavedImageList(name, scene || '', base64);
                return `图片已保存为表情包，名称：${finalName}`;
            } catch (error) {
                return error.message;
            }
        } else {
            return '本地图片不用再次储存';
        }
    }
    
    ToolManager.toolMap[info.function.name] = tool;
}

export function registerDeleteSavedImage() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "delete_saved_image",
            description: "删除保存的表情包图片",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: `要删除的图片名称`
                    }
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ai, args) => {
        const { name } = args;

        const imageIndex = ai.image.imageList.findIndex(img => {
            if (img.content) {
                try {
                    const meta = JSON.parse(img.content);
                    return meta.name === name;
                } catch {
                    return false;
                }
            }
            return false;
        });

        if (imageIndex === -1) {
            return `未找到名称为"${name}"的保存图片`;
        }

        const deletedImage = ai.image.imageList.splice(imageIndex, 1)[0];
        try {
            const meta = JSON.parse(deletedImage.content);
            return `已删除保存的图片：${meta.name}${meta.scene ? `（${meta.scene}）` : ''}`;
        } catch {
            return `已删除保存的图片：${name}`;
        }
    }
    
    ToolManager.toolMap[info.function.name] = tool;
}