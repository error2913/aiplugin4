import { logger } from "../logger";
import { Tool } from "./tool";
import { ConfigManager } from "../config/configManager";
import { AIManager } from "../AI/AI";
import { Image, ImageManager } from "../AI/image";

interface RenderResponse {
    status: string;
    imageId?: string;
    url?: string;
    fileName?: string;
    contentType?: string;
    base64?: string;
    message?: string;
}

async function postToRenderEndpoint(endpoint: string, bodyData: any): Promise<RenderResponse> {
    try {
        const { renderUrl } = ConfigManager.backend;
        const res = await fetch(renderUrl + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const json: RenderResponse = await res.json();
        return json;
    } catch (err) {
        throw new Error('渲染内容失败: ' + err.message);
    }
}

// Markdown 渲染
async function renderMarkdown(markdown: string, theme: 'light' | 'dark' | 'gradient' = 'light', width = 1200) {
    return postToRenderEndpoint('/render/markdown', { markdown, theme, width, quality: 90 });
}

// HTML 渲染
async function renderHtml(html: string, width = 1200) {
    return postToRenderEndpoint('/render/html', { html, width, quality: 90 });
}

export function registerRender() {
    const toolMd = new Tool({
        type: "function",
        function: {
            name: "render_markdown",
            description: `渲染 Markdown 内容为图片`,
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "要渲染的 Markdown 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式"
                    },
                    name: {
                        type: "string",
                        description: "名称，对内容大致描述"
                    },
                    theme: {
                        type: "string",
                        description: "主题样式，其中 gradient 为紫色渐变背景",
                        enum: ["light", "dark", "gradient"],
                    },
                    save: {
                        type: "boolean",
                        description: "是否保存图片"
                    }
                },
                required: ["content", "name", "save"]
            }
        }
    });

    toolMd.solve = async (ctx, msg, ai, args) => {
        const { content, name, theme = 'light', save } = args;
        if (!content || !content.trim()) return { content: `内容不能为空`, images: [] };
        if (!name || !name.trim()) return { content: `图片名称不能为空`, images: [] };
        if (!['light', 'dark', 'gradient'].includes(theme)) return { content: `无效的主题: ${theme}。支持: light, dark, gradient`, images: [] };

        // 切换到当前会话ai
        if (!ctx.isPrivate) ai = AIManager.getAI(ctx.group.groupId);

        try {
            const result = await renderMarkdown(content, theme, 1200);
            if (result.status === "success" && result.base64) {
                logger.info(`Markdown 渲染成功`);
                
                const base64 = result.base64;
                const file = seal.base64ToImage(base64);
                
                const img = new Image(file);
                img.id = ImageManager.generateImageId(ctx, ai, `render_markdown_${name}`);
                img.isUrl = false;
                img.base64 = base64;
                img.content = `Markdown 渲染图片<|img:${img.id}|>
主题：${theme}`;

                if (save) {
                    const kws = ["render", "markdown", name, theme];
                    ai.memory.addMemory(ctx, ai, [], [], kws, [img], img.content);
                }

                seal.replyToSender(ctx, msg, ImageManager.getImageCQCode(img));
                return { content: `渲染成功：<|img:${img.id}|>`, images: [img] };
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`Markdown 渲染失败: ${err.message}`);
            return { content: `渲染图片失败: ${err.message}`, images: [] };
        }
    }

    const toolHtml = new Tool({
        type: "function",
        function: {
            name: "render_html",
            description: `渲染 HTML 内容为图片`,
            parameters: {
                type: "object",
                    properties: {
                        content: {
                            type: "string",
                            description: "要渲染的 HTML 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。"
                        },
                        name: {
                            type: "string",
                            description: "名称，对内容大致描述"
                        },
                        save: {
                            type: "boolean",
                            description: "是否保存图片"
                        }
                    },
                    required: ["content", "name", "save"]
            }
        }
    });

    toolHtml.solve = async (ctx, msg, ai, args) => {
        const { content, name, save } = args;
        if (!content || !content.trim()) return { content: `内容不能为空`, images: [] };
        if (!name || !name.trim()) return { content: `图片名称不能为空`, images: [] };

        // 切换到当前会话ai
        if (!ctx.isPrivate) ai = AIManager.getAI(ctx.group.groupId);

        try {
            const result = await renderHtml(content, 1200);
            if (result.status === "success" && result.base64) {
                logger.info(`HTML 渲染成功`);
                
                const base64 = result.base64;
                const file = seal.base64ToImage(base64);
                
                const img = new Image(file);
                img.id = ImageManager.generateImageId(ctx, ai, `render_html_${name}`);
                img.isUrl = false;
                img.base64 = base64;
                img.content = `HTML 渲染图片<|img:${img.id}|>`;

                if (save) {
                    const kws = ["render", "html", name];
                    ai.memory.addMemory(ctx, ai, [], [], kws, [img], img.content);
                }

                seal.replyToSender(ctx, msg, ImageManager.getImageCQCode(img));
                return { content: `渲染成功：<|img:${img.id}|>`, images: [img] };
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`HTML 渲染失败: ${err.message}`);
            return { content: `渲染图片失败: ${err.message}`, images: [] };
        }
    }
}