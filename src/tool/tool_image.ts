import { ImageManager } from "../AI/image";
import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerFace() {
    const { localImagePaths } = ConfigManager.image;
    const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
        if (path.trim() === '') {
            return acc;
        }
        try {
            const name = path.split('/').pop().split('.')[0];
            if (!name) {
                throw new Error(`本地图片路径格式错误:${path}`);
            }

            acc[name] = path;
        } catch (e) {
            logger.error(e);
        }
        return acc;
    }, {});

    if (Object.keys(localImages).length === 0) {
        return;
    }

    const info: ToolInfo = {
        type: "function",
        function: {
            name: "face",
            description: `发送表情包，表情名称有:${Object.keys(localImages).join("、")}`,
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
    tool.solve = async (ctx, msg, _, args) => {
        const { name } = args;

        if (localImages.hasOwnProperty(name)) {
            seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[name]}]`);
            return '发送成功';
        } else {
            logger.error(`本地图片${name}不存在`);
            return `本地图片${name}不存在`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

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

            url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/\D+/g, '')}&s=640`;
        } else if (avatar_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return `未找到<${name}>`;
            }

            url = `https://p.qlogo.cn/gh/${gid.replace(/\D+/g, '')}/${gid.replace(/\D+/g, '')}/640`;
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