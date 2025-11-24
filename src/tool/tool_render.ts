import { logger } from "../logger";
import { Tool } from "./tool";
import { ConfigManager } from "../config/configManager";
import { AIManager } from "../AI/AI";
import { Image } from "../AI/image";
import { generateId } from "../utils/utils";

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

//替换内容中的图片标签
async function replaceImageReferencesInContent(ctx: seal.MsgContext, ai: any, content: string, renderMode: 'markdown' | 'html'): Promise<{ processedContent: string, errors: string[], hasImages: boolean }> {
    const errors: string[] = [];
    let processedContent = content;
    let hasImages = false;    
    const match = content.match(/[<＜][\|│｜]img:.+?(?:[\|│｜][>＞]|[\|│｜>＞])/g);
    
    if (!match) return { processedContent, errors, hasImages };

    const uniqueRefs = [...new Set(match)];

    for (const imgRef of uniqueRefs) {
        const idMatch = imgRef.match(/[<＜][\|│｜]img:(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/);
        if (!idMatch) continue;
        
        const id = idMatch[1].trim();
        const image = ai.context.findImage(ctx, id);
        
        if (!image) {
            errors.push(`未找到图片<|img:${id}|>`);
            continue;
        }

        if (image.type === 'local' ) {
            errors.push(`图片<|img:${id}|>为本地图片，暂不支持`);
            continue;
        }
        
        let imgUrl = '';
        if (image.type === 'base64') {
            const format = image.format || 'png';
            imgUrl = `data:image/${format};base64,${image.base64}`;
            hasImages = true;
        } else if (image.type === 'url') {
            imgUrl = image.file;
            hasImages = true;
        }
        
        if (!imgUrl) continue;
        
        const escapedRef = imgRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mdSyntaxRegex = new RegExp(`(\\[.*?\\]\\(\\s*)${escapedRef}(\\s*\\))`, 'g');
        if (mdSyntaxRegex.test(processedContent)) {
            processedContent = processedContent.replace(mdSyntaxRegex, `$1${imgUrl}$2`);
        }

        const htmlSrcRegex = new RegExp(`(src\\s*=\\s*['"]\\s*)${escapedRef}(\\s*['"])`, 'g');
        if (htmlSrcRegex.test(processedContent)) {
            processedContent = processedContent.replace(htmlSrcRegex, `$1${imgUrl}$2`);
        }

        // 处理背景图片
        const htmlBgImageRegex = new RegExp(`(background-image:\\s*url\\(['"]\\s*)${escapedRef}(\\s*['"]\\))`, 'g');
        if (htmlBgImageRegex.test(processedContent)) {
            processedContent = processedContent.replace(htmlBgImageRegex, `$1${imgUrl}$2`);
        }

        const standaloneRegex = new RegExp(escapedRef, 'g');
        if (renderMode === 'markdown') {
            processedContent = processedContent.replace(standaloneRegex, `![image](${imgUrl})`);
        } else {
            processedContent = processedContent.replace(standaloneRegex, `<img src="${imgUrl}" />`);
        }
    }
    
    return { processedContent, errors, hasImages };
}

//替换内容中的头像标签
async function replaceAvatarReferencesInContent(ctx: seal.MsgContext, ai: any, content: string, renderMode: 'markdown' | 'html'): Promise<{ processedContent: string, errors: string[], hasImages: boolean }> {
    const errors: string[] = [];
    let processedContent = content;
    let hasImages = false;
    
    const avatarMatch = content.match(/[<＜][\|│｜]avatar:(private|group):(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g);
    
    if (!avatarMatch) return { processedContent, errors, hasImages };

    const uniqueRefs = [...new Set(avatarMatch)];

    for (const avatarRef of uniqueRefs) {
        const match = avatarRef.match(/[<＜][\|│｜]avatar:(private|group):(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/);
        if (!match) continue;
        
        const avatarType = match[1];
        const name = match[2].trim();
        
        let url = '';
        if (avatarType === 'private') {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                errors.push(`未找到用户<${name}>，无法获取头像`);
                continue;
            }
            url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/^.+:/, '')}&s=640`;
        } else if (avatarType === 'group') {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                errors.push(`未找到群聊<${name}>，无法获取头像`);
                continue;
            }
            url = `https://p.qlogo.cn/gh/${gid.replace(/^.+:/, '')}/${gid.replace(/^.+:/, '')}/640`;
        }
        
        if (url) {
            hasImages = true;
            const escapedRef = avatarRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            const mdSyntaxRegex = new RegExp(`(\\[.*?\\]\\(\\s*)${escapedRef}(\\s*\\))`, 'g');
            if (mdSyntaxRegex.test(processedContent)) {
                processedContent = processedContent.replace(mdSyntaxRegex, `$1${url}$2`);
            }

            const htmlSrcRegex = new RegExp(`(src\\s*=\\s*['"]\\s*)${escapedRef}(\\s*['"])`, 'g');
            if (htmlSrcRegex.test(processedContent)) {
                processedContent = processedContent.replace(htmlSrcRegex, `$1${url}$2`);
            }

            // 处理背景图片
            const htmlBgImageRegex = new RegExp(`(background-image:\\s*url\\(['"]\\s*)${escapedRef}(\\s*['"]\\))`, 'g');
            if (htmlBgImageRegex.test(processedContent)) {
                processedContent = processedContent.replace(htmlBgImageRegex, `$1${url}$2`);
            }

            const standaloneRegex = new RegExp(escapedRef, 'g');
            if (renderMode === 'markdown') {
                processedContent = processedContent.replace(standaloneRegex, `![avatar](${url})`);
            } else {
                processedContent = processedContent.replace(standaloneRegex, `<img src="${url}" />`);
            }
        }
    }
    
    return { processedContent, errors, hasImages };
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
                        description: "要渲染的 Markdown 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。可以使用<|img:xxxxxx|>引用图片（xxxxxx为6位图片ID，不支持本地图片）。可以使用<|avatar:private:name|>或<|avatar:group:name|>引用头像"
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

    toolMd.solve = async (ctx, _, ai, args) => {
        const { content, name, theme = 'light', save } = args;
        if (!content || !content.trim()) return { content: `内容不能为空`, images: [] };
        if (!name || !name.trim()) return { content: `图片名称不能为空`, images: [] };
        if (!['light', 'dark', 'gradient'].includes(theme)) return { content: `无效的主题: ${theme}。支持: light, dark, gradient`, images: [] };

        // 切换到当前会话ai
        if (!ctx.isPrivate) ai = AIManager.getAI(ctx.group.groupId);

        const kws = ["render", "markdown", name, theme];

        try {
            const { processedContent: contentWithImages, errors: imageErrors, hasImages: hasImageRefs } = await replaceImageReferencesInContent(ctx, ai, content, 'markdown');           
            const { processedContent: finalContent, errors: avatarErrors, hasImages: hasAvatarRefs } = await replaceAvatarReferencesInContent(ctx, ai, contentWithImages, 'markdown');
            
            const allErrors = [...imageErrors, ...avatarErrors];
            if (allErrors.length > 0) {
                return { content: allErrors.join('\n'), images: [] };
            }
            
            const hasImages = hasImageRefs || hasAvatarRefs;
            
            const result = await renderMarkdown(finalContent, theme, 1200, hasImages);
            if (result.status === "success" && result.base64) {
                const base64 = result.base64;
                if (!base64) {
                    logger.error(`生成的base64为空`);
                    return { content: "生成的base64为空", images: [] };
                }

                const img = new Image();
                img.id = `${name}_${generateId()}`;
                img.base64 = base64;
                img.format = 'unknown';
                img.content = `Markdown 渲染图片<|img:${img.id}|>
主题：${theme}`;

                if (save) ai.memory.addMemory(ctx, ai, [], [], kws, [img], img.content);

                return { content: `渲染成功，请使用<|img:${img.id}|>发送`, images: [img] };
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
                        description: "要渲染的 HTML 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。可以使用<|img:xxxxxx|>引用图片（xxxxxx为图片ID，不支持本地图片)。可以使用<|avatar:private:name|>或<|avatar:group:name|>引用头像"
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

    toolHtml.solve = async (ctx, _, ai, args) => {
        const { content, name, save } = args;
        if (!content || !content.trim()) return { content: `内容不能为空`, images: [] };
        if (!name || !name.trim()) return { content: `图片名称不能为空`, images: [] };

        // 切换到当前会话ai
        if (!ctx.isPrivate) ai = AIManager.getAI(ctx.group.groupId);

        const kws = ["render", "html", name];

        try {
            const { processedContent: contentWithImages, errors: imageErrors, hasImages: hasImageRefs } = await replaceImageReferencesInContent(ctx, ai, content, 'html');
            const { processedContent: finalContent, errors: avatarErrors, hasImages: hasAvatarRefs } = await replaceAvatarReferencesInContent(ctx, ai, contentWithImages, 'html');
            
            const allErrors = [...imageErrors, ...avatarErrors];
            if (allErrors.length > 0) {
                return { content: allErrors.join('\n'), images: [] };
            }
            
            const hasImages = hasImageRefs || hasAvatarRefs;
            
            const result = await renderHtml(finalContent, 1200, hasImages);
            if (result.status === "success" && result.base64) {
                const base64 = result.base64;
                if (!base64) {
                    logger.error(`生成的base64为空`);
                    return { content: "生成的base64为空", images: [] };
                }

                const img = new Image();
                img.id = `${name}_${generateId()}`;
                img.base64 = base64;
                img.format = 'unknown';
                img.content = `HTML 渲染图片<|img:${img.id}|>`;

                if (save) ai.memory.addMemory(ctx, ai, [], [], kws, [img], img.content);

                return { content: `渲染成功，请使用<|img:${img.id}|>发送`, images: [img] };
            } else {
                throw new Error(result.message || "渲染失败");
            }
        } catch (err) {
            logger.error(`HTML 渲染失败: ${err.message}`);
            return { content: `渲染图片失败: ${err.message}`, images: [] };
        }
    }
}

// TODO:嵌入本地图片
