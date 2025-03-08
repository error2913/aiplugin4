import { Tool, ToolInfo, ToolManager } from "./tool";

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
            console.error(`未找到AIDrawing依赖`);
            return `未找到AIDrawing依赖，请提示用户安装AIDrawing依赖`;
        }

        try {
            await globalThis.aiDrawing.generateImage(prompt, ctx, msg, negative_prompt);
            return `图像生成请求已发送`;
        } catch (e) {
            console.error(`图像生成失败：${e}`);
            return `图像生成失败：${e}`;
        }
    };

    ToolManager.toolMap[info.function.name] = tool;
}