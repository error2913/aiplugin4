import { Image, ImageManager } from "../AI/image";
import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { Tool } from "./tool";

export function registerImage() {
    const toolText = new Tool({
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
    toolText.solve = async (_, __, ai, args) => {
        const { id, content } = args;

        const image = ai.context.findImage(id, ai.imageManager);
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

    const toolImage = new Tool({
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
    toolImage.solve = async (ctx, msg, _, args) => {
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
    }

    const toolSave = new Tool({
        type: "function",
        function: {
            name: "save_image",
            description: "将图片保存为表情包",
            parameters: {
                type: "object",
                properties: {
                    images: {
                        type: "array",
                        description: "要保存的图片信息数组",
                        items: {
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
                                scenes: {
                                    type: "array",
                                    description: `表情包的应用场景`,
                                    items: {
                                        type: "string"
                                    }
                                }
                            }
                        }
                    }
                },
                required: ["images"]
            }
        }
    });
    toolSave.solve = async (_, __, ai, args) => {
        const { images } = args;

        const savedImages: Image[] = [];
        for (const ii of images) {
            const { id, name, scenes } = ii;

            if (!id || !name || !scenes || scenes.length === 0) {
                return `图片${id}信息不完整，缺少id、name或scenes为空`;
            }

            const image = ai.context.findImage(id, ai.imageManager);
            if (!image) {
                return `未找到图片${id}`;
            }

            if (image.isUrl) {
                const { base64 } = await ImageManager.imageUrlToBase64(image.file);
                if (!base64) {
                    logger.error(`图片${id}转换为base64失败`);
                    return `图片转换为base64失败`;
                }

                const newImage = new Image(image.file);
                newImage.id = ImageManager.generateImageId(ai, name);
                newImage.isUrl = false;
                newImage.scenes = scenes;
                newImage.base64 = base64;
                newImage.content = image.content;

                savedImages.push(newImage);
            } else {
                return '本地图片不用再次储存';
            }
        }


        try {
            ai.imageManager.updateSavedImages(savedImages);
            return `图片已保存`;
        } catch (e) {
            return `图片保存失败：${e.message}`
        }
    }

    const toolDel = new Tool({
        type: "function",
        function: {
            name: "del_image",
            description: "删除保存的表情包图片",
            parameters: {
                type: "object",
                properties: {
                    names: {
                        type: "array",
                        description: `要删除的图片名称数组`
                    }
                },
                required: ["names"]
            }
        }
    });
    toolDel.solve = async (_, __, ai, args) => {
        const { names } = args;

        for (const name of names) {
            const imageIndex = ai.imageManager.savedImages.findIndex(img => img.id === name);
            if (imageIndex === -1) {
                return `未找到名称为"${name}"的保存图片`;
            }

            ai.imageManager.savedImages.splice(imageIndex, 1);
        }

        return `已删除${names.length}个图片`;
    }
}