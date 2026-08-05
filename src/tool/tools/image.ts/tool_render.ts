// 渲染工具：Markdown/HTML 转图片
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Image from "../../../resource/image";
import { Session } from "../../../session/session";
import { parseSpecialTokens } from "../../../utils/string";
import { generateId } from "../../../utils/utils";
import Tool from "../../tool";

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
        const { RENDER: renderUrl } = Config.backend;
        const res = await fetch(renderUrl + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const json: RenderResponse = await res.json();
        return json;
    } catch (err) {
        throw new Error('渲染内容失败: ' + (err instanceof Error ? err.message : String(err)));
    }
}

async function transformContentToUrlText(ctx: seal.MsgContext, session: Session, content: string): Promise<{ text: string, images: Image[] }> {
    const segs = parseSpecialTokens(content);
    let text = '';
    const images: Image[] = [];
    for (const seg of segs) {
        switch (seg.type) {
            case 'text': {
                text += seg.content;
                break;
            }
            case 'at': {
                const name = seg.content;
                const ui = await session.context.findUser(ctx, name);
                if (ui !== null) {
                    text += ` @${ui.userName} `;
                } else {
                    logger.warning(`无法找到用户：${name}`);
                    text += ` @${name} `;
                }
                break;
            }
            case 'img': {
                const id = seg.content;
                const image = await session.context.findImage(ctx, id);

                if (image) {
                    if (image.type === 'local') throw new Error(`图片<|img:${id}|>为本地图片，暂不支持`);
                    images.push(image);
                    text += image.url;
                } else {
                    logger.warning(`无法找到图片：${id}`);
                }
                break;
            }
        }
    }
    return { text, images };
}

// Markdown 渲染
async function renderMarkdown(markdown: string, theme: 'light' | 'dark' | 'gradient' = 'light', width = 1200, hasImages = false) {
    return postToRenderEndpoint('/render/markdown', { markdown, theme, width, quality: 90, hasImages });
}

// HTML 渲染
async function renderHtml(html: string, width = 1200, hasImages = false) {
    return postToRenderEndpoint('/render/html', { html, width, quality: 90, hasImages });
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
                        description: "要渲染的 Markdown 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。可以使用<|img:xxxxxx|>替代图片url（注意使用markdown语法显示图片），xxxxxx为" + `图片id，或user_avatar:用户名称` + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '') + `，或group_avatar:群聊名称` + (Config.message.SHOW_NUMBER ? '或纯数字群号' : '')
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

    toolMd.solve = async (ctx, _, session, args) => {
        const { content, name, theme = 'light', save } = args;
        if (!content || !content.trim()) return `内容不能为空`;
        if (!name || !name.trim()) return `图片名称不能为空`;
        if (!['light', 'dark', 'gradient'].includes(theme)) return `无效的主题: ${theme}。支持: light, dark, gradient`;

        // 切换到当前会话ai
        // 会话已由 Tool.handleToolCall 传入，直接使用 session

        const kws = ["render", "markdown", name, theme];

        try {
            const { text, images } = await transformContentToUrlText(ctx, session, content);
            const hasImages = images.length > 0;

            const result = await renderMarkdown(text, theme, 1200, hasImages);
            if (result.status === "success" && result.base64) {
                const base64 = result.base64;
                if (!base64) {
                    logger.error(`生成的base64为空`);
                    return "生成的base64为空";
                }

                const img = new Image();
                img.imageId = `${name}_${generateId()}`;
                img.base64 = base64;
                img.format = 'unknown';
                img.description = `Markdown 渲染图片<|img:${img.imageId}|>
主题：${theme}`;

                if (save) session.memory.addMemory(ctx, session, [], [], kws, [img], img.description);

                return `渲染成功，请使用<|img:${img.imageId}|>发送`;
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`Markdown 渲染失败: ${err instanceof Error ? err.message : String(err)}`);
            return `渲染图片失败: ${err instanceof Error ? err.message : String(err)}`;
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
                        description: "要渲染的 HTML 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。可以使用<|img:xxxxxx|>替代图片url（注意使用html元素显示图片），xxxxxx为" + `图片id，或user_avatar:用户名称` + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '') + `，或group_avatar:群聊名称` + (Config.message.SHOW_NUMBER ? '或纯数字群号' : '')
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

    toolHtml.solve = async (ctx, _, session, args) => {
        const { content, name, save } = args;
        if (!content || !content.trim()) return `内容不能为空`;
        if (!name || !name.trim()) return `图片名称不能为空`;

        // 切换到当前会话ai
        // 会话已由 Tool.handleToolCall 传入，直接使用 session

        const kws = ["render", "html", name];

        try {
            const { text, images } = await transformContentToUrlText(ctx, session, content);
            const hasImages = images.length > 0;

            const result = await renderHtml(text, 1200, hasImages);
            if (result.status === "success" && result.base64) {
                const base64 = result.base64;
                if (!base64) {
                    logger.error(`生成的base64为空`);
                    return "生成的base64为空";
                }

                const img = new Image();
                img.imageId = `${name}_${generateId()}`;
                img.base64 = base64;
                img.format = 'unknown';
                img.description = `HTML 渲染图片<|img:${img.imageId}|>`;

                if (save) session.memory.addMemory(ctx, session, [], [], kws, [img], img.description);

                return `渲染成功，请使用<|img:${img.imageId}|>发送`;
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`HTML 渲染失败: ${err instanceof Error ? err.message : String(err)}`);
            return `渲染图片失败: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}

// TODO:嵌入本地图片
