import { logger } from "../logger";
import { Tool } from "./tool";
import { ConfigManager } from "../config/configManager";

interface RenderResponse {
    status: string;
    imageId?: string;
    url?: string;
    fileName?: string;
    contentType?: string;
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

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

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
                        description: "要渲染的 Markdown 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。"
                    },
                    theme: {
                        type: "string",
                        description: "主题样式，其中 gradient 为紫色渐变背景",
                        enum: ["light", "dark", "gradient"],
                    }
                },
                required: ["content"]
            }
        }
    });

    toolMd.solve = async (ctx, msg, _, args) => {
        const { content, theme = 'light' } = args;
        if (!content || !content.trim()) return { content: `内容不能为空`, images: [] };
        if (!['light', 'dark', 'gradient'].includes(theme)) return { content: `无效的主题: ${theme}。支持: light, dark, gradient`, images: [] };

        try {
            const result = await renderMarkdown(content, theme, 1200);
            if (result.status === "success" && result.url) {
                logger.info(`Markdown 渲染成功, URL: ${result.url}`);
                seal.replyToSender(ctx, msg, `[CQ:image,file=${result.url}]`);
                return { content: `渲染成功，已发送`, images: [] };
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
                        }
                    },
                    required: ["content"]
            }
        }
    });

    toolHtml.solve = async (ctx, msg, _, args) => {
        const { content } = args;
        if (!content || !content.trim()) return { content: `内容不能为空`, images: [] };

        try {
            const result = await renderHtml(content, 1200);
            if (result.status === "success" && result.url) {
                logger.info(`HTML 渲染成功, URL: ${result.url}`);
                seal.replyToSender(ctx, msg, `[CQ:image,file=${result.url}]`);
                return { content: `渲染成功，已发送`, images: [] };
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`HTML 渲染失败: ${err.message}`);
            return { content: `渲染图片失败: ${err.message}`, images: [] };
        }
    }

}