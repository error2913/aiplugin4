import { logger } from "../logger";
import { Tool } from "./tool";
import { ConfigManager } from "../config/config";

interface RenderResponse {
    status: string;
    imageId?: string;
    url?: string;
    fileName?: string;
    contentType?: string;
    message?: string;
}

/**
 * 渲染内容为图片
 * @param content - 要渲染的内容（Markdown 或 HTML）
 * @param contentType - 内容类型：'auto'(自动检测), 'markdown', 'html'
 * @param theme - 主题：'light', 'dark', 'gradient'
 * @param width - 图片宽度
 */
async function renderContent(
    content: string,
    contentType: 'auto' | 'markdown' | 'html' = 'auto',
    theme: 'light' | 'dark' | 'gradient' = 'light',
    width: number = 1200
): Promise<RenderResponse> {
    try {
        const { renderUrl } = ConfigManager.backend;
        const res = await fetch(renderUrl + "/render", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                content,
                contentType,
                theme,
                width,
                quality: 90
            })
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const json: RenderResponse = await res.json();
        return json;
    } catch (err) {
        throw new Error("渲染内容失败: " + err.message);
    }
}

export function registerRender() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "render_content",
            description: `渲染Markdown或HTML内容为图片`,
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "要渲染的内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。"
                    },
                    contentType: {
                        type: "string",
                        description: "内容类型",
                        enum: ["auto", "markdown", "html"],
                    },
                    theme: {
                        type: "string",
                        description: "主题样式，其中gradient为紫色渐变背景",
                        enum: ["light", "dark", "gradient"],
                    }
                },
                required: ["content"]
            }
        }
    });

    tool.solve = async (ctx, msg, _, args) => {
        const { content, contentType = 'auto', theme = 'light' } = args;

        if (!content.trim()) return { content: `内容不能为空`, images: [] };

        if (!['auto', 'markdown', 'html'].includes(contentType)) return { content: `无效的内容类型: ${contentType}。支持: auto, markdown, html`, images: [] };
        if (!['light', 'dark', 'gradient'].includes(theme)) return { content: `无效的主题: ${theme}。支持: light, dark, gradient`, images: [] };

        try {
            const result = await renderContent(content, contentType as any, theme, 1200);

            if (result.status === "success" && result.url) {
                const actualType = result.contentType || contentType;
                logger.info(`渲染成功，实际类型: ${actualType}, URL: ${result.url}`);

                seal.replyToSender(ctx, msg, `[CQ:image,file=${result.url}]`);
                return { content: `渲染成功，已发送 (${actualType})`, images: [] };
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`内容渲染失败: ${err.message}`);
            return { content: `渲染图片失败: ${err.message}`, images: [] };
        }
    };
}