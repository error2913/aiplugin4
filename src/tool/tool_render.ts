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
    theme: string = 'light', 
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
            description: `将 Markdown 或 HTML 内容渲染为精美的图片。支持：
• Markdown 语法：标题、列表、代码块、表格、引用等;
• HTML 标签：可以直接使用 HTML 进行更灵活的排版;
• LaTeX 数学公式：行内公式 $...$，块级公式 $$...$$;
适合用于展示格式化的文本内容、教程、说明文档、数学公式等。`,
            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "要渲染的内容（Markdown 或 HTML 格式）。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。"
                    },
                    contentType: {
                        type: "string",
                        description: "内容类型：auto(自动检测，推荐), markdown, html",
                        enum: ["auto", "markdown", "html"],
                    },
                    theme: {
                        type: "string",
                        description: "主题样式: light(亮色主题，白色背景), dark(暗色主题，深色背景), gradient(渐变主题，紫色渐变背景)",
                        enum: ["light", "dark", "gradient"],
                    }
                },
                required: ["content"]
            }
        }
    });

    tool.solve = async (ctx, msg, _, args) => {
        const { 
            content, 
            contentType = 'auto',
            theme = 'light' 
        } = args;

        if (!content || content.trim() === '') {
            return { content: `内容不能为空`, images: [] };
        }

        const validContentTypes = ['auto', 'markdown', 'html'];
        if (!validContentTypes.includes(contentType)) {
            return { 
                content: `无效的内容类型: ${contentType}。支持: ${validContentTypes.join(', ')}`, 
                images: [] 
            };
        }

        const validThemes = ['light', 'dark', 'gradient'];
        if (!validThemes.includes(theme)) {
            return { 
                content: `无效的主题: ${theme}。支持: ${validThemes.join(', ')}`, 
                images: [] 
            };
        }

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