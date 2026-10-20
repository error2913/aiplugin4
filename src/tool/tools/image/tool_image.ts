// 图片工具：看图（image_view）/ 图片转文字（image_to_text）/ 文生图（内置媒体队列）
// 图片入参统一走 CIR（Image.resolveRef）：支持 [img:<ref>]、图床 h<sha256>、裸 sha256、插件图片 ID、头像。
import Config from "../../../config/config";
import { logger } from "../../../logger";
import { MediaTaskManager } from "../../../media/task_queue";
import Model from "../../../model/model";
import Image from "../../../resource/image";
import { parseImageRef } from "../../../resource/image_ref";
import { ToolContentPart } from "../../../tool/types";
import Tool from "../../tool";
import { buildMediaSubmitReply, buildMediaToolInfo, resolveMediaEntry } from "../media/shared";

const log = logger.withTag('tool');

/** image_view：单次最多看几张 */
const IMAGE_VIEW_MAX_IMAGES = 4;
/** image_view / image_to_text 降级：单次最多描述几张（每张一次识图调用） */
const IMAGE_VIEW_MAX_DESCRIBE = 3;
/** image_view：单张内联 base64 上限（MB；先按 base64 长度粗判） */
const IMAGE_VIEW_INLINE_MAX_MB = 4;
/** image_view：单次内联 base64 总量上限（MB；先按 base64 长度粗判） */
const IMAGE_VIEW_TOTAL_MB = 12;

/** MB → base64 字符数（base64 体积约为原始字节的 4/3） */
function mbToBase64Chars(mb: number): number {
    return Math.floor(mb * 1024 * 1024 * 4 / 3);
}

/** 引用标签里使用的规范 id：优先 CIR canonical（图床 h<sha>），否则用图片自身的 imageId */
function canonicalOf(raw: string, image: Image | null): string {
    const parsed = parseImageRef(raw);
    if (parsed) return parsed.canonical;
    return image ? image.imageId : raw;
}

interface ResolvedItem {
    raw: string;
    image: Image | null;
    canonical: string;
}

/** 逐个解析 CIR；失败项不拖垮整批 */
function resolveAll(raws: string[]): ResolvedItem[] {
    return raws.map(raw => {
        const image = Image.resolveRef(raw);
        return { raw, image, canonical: canonicalOf(raw, image) };
    });
}

/** 批量参数归一：id / ids 二选一，并检查上限；返回错误文本（调用方直接返回） */
function collectRefs(args: any, max: number, toolName: string): { raws: string[]; error?: string } {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const ids = Array.isArray(args.ids)
        ? args.ids.map((x: any) => String(x ?? "").trim()).filter(Boolean)
        : [];
    if (id && ids.length > 0) return { raws: [], error: `${toolName} 的 id 与 ids 只能二选一` };
    const raws = id ? [id] : ids;
    if (raws.length === 0) return { raws: [], error: `${toolName} 需要 id 或 ids（单次最多 ${max} 张）` };
    if (raws.length > max) {
        return { raws: [], error: `${toolName} 单次最多 ${max} 张，请分批调用（当前 ${raws.length} 张）` };
    }
    return { raws };
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * 文生图参考图：CIR / 图床 ID → 模型（上游）可消费的 URL 或 data URL。
 * 直接传 http(s) / data: / 裸 base64 时原样使用。
 */
async function resolveTtiImage(_ctx: seal.MsgContext, _session: any, raw: string): Promise<string | null> {
    const input = String(raw || '').trim();
    if (!input) return null;

    if (/^data:/i.test(input) || /^https?:\/\//i.test(input)) return input;

    // 直接传入 base64 时原样返回；长度阈值用于避免把普通图片 ID 误判为 base64。
    const compact = input.replace(/\s+/g, '');
    if (compact.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(compact)) return input;

    const image = Image.resolveRef(input);
    if (!image) return null;

    // 图床/URL/头像：按模型/上游可达性自动选 URL 或内联 b64（回环图床给 data URL）
    try {
        const src = await image.getModelSrc();
        if (src) return src;
    } catch (e) {
        log.warning(`参考图取图失败: ${errText(e)}`);
    }
    // 回退原逻辑：本地图片没有可外发的地址；其余退回原始 url/path
    if (image.type === 'local') return null;
    return image.url || image.path || null;
}

export function registerImage() {
    // ========== image_to_text：图片转文字（支持批量 ids，最多 3 张） ==========
    const toolITT = new Tool({
        type: "function",
        function: {
            name: "image_to_text",
            description: "查看图片内容并返回文字描述（由识图模型转述，适合不想让图片占用对话上下文、或聊天模型不支持视觉时使用）。" +
                "id 支持标准图片引用 [img:<ref>]、图床托管 ID h<sha256>、裸 sha256、插件图片 ID、user_avatar:/group_avatar:；" +
                `支持批量 ids[]（单次最多 ${IMAGE_VIEW_MAX_DESCRIBE} 张）。多模态聊天模型想自己直接看图请用 image_view。`,
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "图片引用（与 ids 二选一）"
                    },
                    ids: {
                        type: "array",
                        items: { type: "string" },
                        maxItems: IMAGE_VIEW_MAX_DESCRIBE,
                        description: `批量图片引用（与 id 二选一，单次最多 ${IMAGE_VIEW_MAX_DESCRIBE} 张）`
                    },
                    content: {
                        type: "string",
                        description: "需要特别关注的内容（可选）"
                    }
                },
                additionalProperties: false
            }
        }
    });
    toolITT.solve = async (_ctx, _, _session, args) => {
        const { raws, error } = collectRefs(args, IMAGE_VIEW_MAX_DESCRIBE, 'image_to_text');
        if (error) return error;
        const focus = typeof args.content === "string" ? args.content.trim() : "";
        const prompt = focus ? `请帮我用简短的语言概括这张图片中出现的:${focus}` : "";

        const items = resolveAll(raws);
        const lines: string[] = [`共 ${items.length} 张（单次最多 ${IMAGE_VIEW_MAX_DESCRIBE} 张）：`];
        for (let i = 0; i < items.length; i++) {
            const { image, canonical } = items[i];
            const seq = `${i + 1}. [img:${canonical}]`;
            if (!image) {
                lines.push(`${seq} 未找到该图片引用`);
                continue;
            }
            if (image.type === 'local') {
                lines.push(`${seq} 本地图片暂时无法识别`);
                continue;
            }
            try {
                await image.imageToText(prompt);
                if (!image.description) {
                    lines.push(`${seq} 识别失败（识图模型未配置、取图失败或图片已删除）`);
                } else {
                    lines.push(`${seq} 描述：${image.description}`);
                    if (image.rawDescription) {
                        lines.push(`   完整识别原文：read_raw kind=image id=${image.imageId}`);
                    }
                }
            } catch (e) {
                lines.push(`${seq} 识别失败：${errText(e)}`);
            }
        }
        return lines.join('\n');
    }

    // ========== image_view：直接看图（多模态聊天模型；不支持视觉时降级文字描述） ==========
    const toolView = new Tool({
        type: "function",
        function: {
            name: "image_view",
            description: "直接查看图片内容（把图片交给当前多模态聊天模型）。" +
                "id 支持标准图片引用 [img:<ref>]、图床托管 ID h<sha256>、裸 sha256、插件图片 ID、user_avatar:/group_avatar:；" +
                `支持批量 ids[]（单次最多 ${IMAGE_VIEW_MAX_IMAGES} 张）。当前聊天模型不支持视觉或取图失败时会自动降级为文字描述。` +
                "注意：最终回复里写 [img:<ref>] 是发给用户，不是自己看图；要自己看图必须调用本工具（或 image_to_text）。",
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "单张图片引用（与 ids 二选一）"
                    },
                    ids: {
                        type: "array",
                        items: { type: "string" },
                        maxItems: IMAGE_VIEW_MAX_IMAGES,
                        description: `批量图片引用（与 id 二选一，单次最多 ${IMAGE_VIEW_MAX_IMAGES} 张，超过请分批）`
                    },
                    detail: {
                        type: "string",
                        description: "可选：特别想看清图中的什么细节"
                    }
                },
                additionalProperties: false
            }
        }
    });
    toolView.solve = async (_ctx, _msg, _session, args) => {
        const { raws, error } = collectRefs(args, IMAGE_VIEW_MAX_IMAGES, 'image_view');
        if (error) return error;
        const detail = typeof args.detail === "string" ? args.detail.trim() : "";

        const items = resolveAll(raws);
        const missing = items.filter(it => !it.image);
        const found = items.filter((it): it is ResolvedItem & { image: Image } => !!it.image);

        const lines: string[] = [`共 ${items.length} 张（单次最多 ${IMAGE_VIEW_MAX_IMAGES} 张）：`];
        for (const m of missing) lines.push(`[img:${m.canonical}] 未找到该图片引用`);

        const chatModel = Model.getChatModel('chat');
        const multimodal = !!(chatModel && chatModel.isMultimodal);
        const imageParts: ToolContentPart[] = [];
        const skipped: string[] = [];
        const inlineLimit = mbToBase64Chars(IMAGE_VIEW_INLINE_MAX_MB);
        const totalLimit = mbToBase64Chars(IMAGE_VIEW_TOTAL_MB);
        let inlineChars = 0;

        if (multimodal) {
            for (const item of found) {
                let part: { type: 'image_url'; image_url: { url: string } } | null = null;
                try {
                    part = await Image.toModelPart(item.image, chatModel || undefined);
                } catch (e) {
                    log.warning(`image_view 取图失败 ${item.canonical}: ${errText(e)}`);
                }
                if (!part) {
                    skipped.push(item.image.type === 'local'
                        ? `[img:${item.canonical}] 本地图片无法内联查看，请改用 image_to_text 或直接发送`
                        : `[img:${item.canonical}] 取图失败，请改用 image_to_text 查看`);
                    continue;
                }
                const url = (part.image_url && part.image_url.url) || '';
                if (url.startsWith('data:')) {
                    if (url.length > inlineLimit) {
                        skipped.push(`[img:${item.canonical}] 单张超过 ${IMAGE_VIEW_INLINE_MAX_MB}MB 内联上限，已跳过（请改用 image_to_text）`);
                        continue;
                    }
                    if (inlineChars + url.length > totalLimit) {
                        skipped.push(`[img:${item.canonical}] 超过单次 ${IMAGE_VIEW_TOTAL_MB}MB 内联总量上限，已跳过（请分批查看）`);
                        continue;
                    }
                    inlineChars += url.length;
                }
                imageParts.push(part);
                lines.push(`${imageParts.length}. [img:${item.canonical}]`);
            }
            if (imageParts.length > 0) {
                lines.push(...skipped);
                if (detail) lines.push(`关注点：${detail}`);
                const text = lines.join('\n');
                return {
                    text,
                    contentParts: [{ type: 'text', text } as ToolContentPart, ...imageParts]
                };
            }
            // 多模态但一张都没取到：继续走文字降级
        }

        // 降级：非多模态 / 全部取图失败 → 逐张识图转文字（最多 3 张）
        if (found.length === 0) {
            lines.push(...skipped, '当前没有可查看的图片');
            return lines.join('\n');
        }
        const describeItems = found.slice(0, IMAGE_VIEW_MAX_DESCRIBE);
        const prompt = detail ? `请帮我用简短的语言概括这张图片中出现的:${detail}` : "";
        const out: string[] = [
            `${multimodal ? '图片取图失败' : '当前聊天模型不支持视觉'}，已降级为文字描述（单次最多 ${IMAGE_VIEW_MAX_DESCRIBE} 张）：`,
        ];
        for (let i = 0; i < describeItems.length; i++) {
            const { image, canonical } = describeItems[i];
            const seq = `${i + 1}. [img:${canonical}]`;
            if (image.type === 'local') {
                out.push(`${seq} 本地图片暂时无法识别`);
                continue;
            }
            try {
                await image.imageToText(prompt);
                out.push(image.description ? `${seq} 描述：${image.description}` : `${seq} 识别失败（识图模型未配置、取图失败或图片已删除）`);
            } catch (e) {
                out.push(`${seq} 识别失败：${errText(e)}`);
            }
        }
        if (found.length > describeItems.length) {
            out.push(`另有 ${found.length - describeItems.length} 张未处理（单次最多 ${IMAGE_VIEW_MAX_DESCRIBE} 张），请分批调用`);
        }
        out.push(...skipped);
        if (detail) out.push(`关注点：${detail}`);
        return out.join('\n');
    }

    // ========== text_to_image：文生图（提交任务） ==========
    const toolTTI = new Tool(buildMediaToolInfo({
        name: 'text_to_image',
        description:
            '生成图片（提交生成任务，立即返回任务号；生成完成后会自动通知你，届时在回复里用返回的 [img:图片ID] 把图发给用户）。',
        properties: {
            prompt: { type: 'string', description: '图像描述' },
            negative_prompt: { type: 'string', description: '不希望图片中出现的内容描述' },
            model: { type: 'string', description: '可选，指定生图模型（来自「api连接」）；缺省用 image-generation 用途默认模型' },
            save: { type: 'boolean', description: '是否保存图片（生成完成后写入记忆）' },
            name: { type: 'string', description: '如果保存图片，图片的名称' },
            image: {
                type: 'string',
                description: '可选参考图，用于以图生图。支持标准图片引用 [img:<ref>]、图床托管 ID h<sha256>、插件图片 ID、user_avatar:用户ID、group_avatar:群ID、http(s)图片URL、data:image/...;base64或base64数据'
            }
        },
        required: ['prompt'],
    }, 'image-generation'));

    toolTTI.solve = async (ctx, _msg, session, args) => {
        const { prompt, negative_prompt, save, name, image } = args;
        if (!prompt || typeof prompt !== 'string') return '必须提供 prompt';

        try {
            await Model.ensureLoaded();
            const { entry, error } = resolveMediaEntry('image-generation', args.model);
            if (!entry) return JSON.stringify({ ok: false, code: 'MEDIA_MODEL_UNAVAILABLE', message: error });

            // 参考图在提交时解析（需要 ctx/session）；base64 只进内存，不落盘
            let reference = '';
            if (image) {
                const resolved = await resolveTtiImage(ctx, session, image);
                if (!resolved) return `未找到参考图${image}（支持 [img:<ref>] / 图床 ID / 插件图片 ID / 图片 URL / base64）`;
                reference = resolved;
            }

            // 同步校验（不建任务；双密钥鉴权会在此换 token）
            const prepared = await entry.prepareTTI(prompt, { negativePrompt: negative_prompt, image: reference, params: args });
            if ('error' in prepared) {
                return JSON.stringify({ ok: false, code: 'MEDIA_PARAM_ERROR', message: prepared.error });
            }

            const task = MediaTaskManager.submit({
                ctx,
                kind: 'tti',
                origin: 'tool',
                entry,
                text: prompt,
                image: reference,
                negativePrompt: typeof negative_prompt === 'string' ? negative_prompt : '',
                params: args,
                save: save === true,
                name: typeof name === 'string' ? name : '',
                modelLabel: entry.ref,
            });
            const queued = MediaTaskManager.pendingCount(task.sid) - 1;

            // 同步等待窗口：生成够快就当场返回结果，不再走异步通知（省一轮唤醒、也避免撞会话闸门）
            const waitMs = Number(Config.tool.MEDIA_SYNC_WAIT_SECONDS) * 1000;
            const settled = await MediaTaskManager.waitForSettle(task, waitMs);
            if (settled) {
                return buildMediaSubmitReply({
                    mode: 'sync',
                    taskId: task.id,
                    kind: 'tti',
                    modelLabel: entry.ref,
                    queued,
                    imageId: settled.result?.imageId,
                    errorText: settled.status === 'failed' ? (settled.error || '未知错误') : undefined,
                });
            }
            return buildMediaSubmitReply({
                mode: 'async',
                taskId: task.id,
                kind: 'tti',
                modelLabel: entry.ref,
                queued,
            });
        } catch (e) {
            log.exception('提交生图任务失败', e);
            return `提交生图任务失败：${e instanceof Error ? e.message : String(e)}`;
        }
    }
}
