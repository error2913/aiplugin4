// 图片工具：图片转文字/文生图（内置媒体队列）
import Config from "../../../config/config";
import { logger } from "../../../logger";
import { MediaTaskManager } from "../../../media/task_queue";
import Model from "../../../model/model";
import { ImageHost } from "../../../resource/image_host";
import Tool from "../../tool";
import { buildMediaSubmitReply, buildMediaToolInfo, resolveMediaEntry } from "../media/shared";

const log = logger.withTag('tool');

async function resolveTtiImage(ctx: seal.MsgContext, session: any, raw: string): Promise<string | null> {
    let input = String(raw || '').trim();
    if (!input) return null;

    const tagMatch = input.match(/^[[［]img[:：]\s?([^\]］]+)[\]］]$/i);
    if (tagMatch) input = tagMatch[1].trim();

    if (/^data:/i.test(input) || /^https?:\/\//i.test(input)) return input;

    // 直接传入 base64 时原样返回；长度阈值用于避免把普通图片 ID 误判为 base64。
    const compact = input.replace(/\s+/g, '');
    if (compact.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(compact)) return input;

    const image = await session.context.findImage(ctx, input)
        || (input.includes(':') ? await session.context.findImage(ctx, input.split(':')[0]) : null);
    if (!image) return null;
    if (image.type === 'local') return null;

    if (image.type === 'url') {
        // 图床配成 IP/域名：参考图直接给图床稳定地址（模型/上游可访问，省一次 base64 过路费）；
        // 回环地址模型访问不到，才回退取内联字节。
        if (image.hosted && ImageHost.externalEnabled) return image.remoteUrl;
        try {
            await image.ensureBytes();
        } catch (e) {
            log.warning(`参考图取字节失败: ${e}`);
        }
        return image.base64 ? image.base64Url : image.src;
    }

    return image.base64Url;
}

export function registerImage() {
    const toolITT = new Tool({
        type: "function",
        function: {
            name: "image_to_text",
            description: `查看图片中的内容，可指定需要特别关注的内容`,
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: '图片ID，或user_avatar:用户ID，或group_avatar:群ID'
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
    toolITT.solve = async (ctx, _, session, args) => {
        const { id, content } = args;

        const image = await session.context.findImage(ctx, id);
        if (!image) return `未找到图片${id}`;
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (image.type === 'local') return '本地图片暂时无法识别';
        await image.imageToText(text);
        return image.description || '图片识别失败';
    }

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
                description: '可选参考图，用于以图生图。支持图片ID、user_avatar:用户ID、group_avatar:群ID、http(s)图片URL、data:image/...;base64或base64数据'
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
                if (!resolved) return `未找到参考图${image}`;
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
