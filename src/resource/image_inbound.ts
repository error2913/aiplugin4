// 图片接收适配：把一条 image 消息段转成 [img:...] 文本 + Image 实体（含按配置自动识别）。
// 从 resource/image.ts 拆出——接收路径依赖 Config/seal 上下文，与图片实体/存储/发送解耦；
// 调用方（utils/string）直接 import 本函数，Image 类不再承载入口适配。
import Config from "../config/config";
import { logger } from "../logger";
import { buildImageTruncateMarker } from "../utils/raw_marker";
import { getSessionId } from "../utils/seal";
import type { MessageSegment } from "../utils/string";
import { getPlatform } from "../utils/target_id";

import Image from "./image";
import type { ImageSource } from "./image_host";

const log = logger.withTag('image');

/**
 * 提取并替换 CQ 码中的图片（接收路径入口）。
 */
export async function handleImageMessageSegment(ctx: seal.MsgContext, seg: MessageSegment, messageId = ''): Promise<{ content: string, images: Image[] }> {
    const { RECEIVE_IMAGE } = Config.received;
    if (!RECEIVE_IMAGE || seg.type !== 'image') return { content: '', images: [] };

    let content = '';
    const images: Image[] = [];
    try {
        const rawFile = seg.data.url || seg.data.file || '';
        // Milky 原生 image 的 file 是 FileElement 对象，OB11 通常是字符串；
        // 统一取 URL/本地文件字段，避免把对象写入 Image.url 后在 type getter 中报错。
        const file = typeof rawFile === 'object' && rawFile !== null
            ? ((rawFile as any).url || (rawFile as any).file || '')
            : String(rawFile);
        if (!file) return { content: '', images: [] };

        const sid = getSessionId(ctx);
        const source: ImageSource = {
            platform: getPlatform(sid),
            group_id: ctx.group ? String(ctx.group.groupId) : '',
            user_id: ctx.player ? String(ctx.player.userId) : '',
            message_id: messageId,
            at: Date.now(),
        };
        for (const key of Object.keys(source) as Array<keyof ImageSource>) {
            if (!source[key]) delete source[key];   // 空字段不占地方
        }
        const image = Image.createUrlImage(sid, file, undefined, source);
        // 保留接收到的原始段字段（file/file_unique/md5/subType/url 等），供 resolve_special_id 查询
        try {
            image.raw = JSON.stringify(seg.data || {});
        } catch (_e) {
            image.raw = '';
        }
        const { IMAGE_CONDITION } = Config.image;
        const fmtCondition = parseInt(seal.format(ctx, `{${IMAGE_CONDITION}}`));
        if (fmtCondition === 1) await image.imageToText();
        Image.save(image); // 持久化原始字段

        content += image.description ? `[img:${image.imageId}:${image.description}]` : `[img:${image.imageId}]`;
        // 展示描述被截断时（rawDescription 存在且长于展示），在 [img] 标签外追加指针标记，
        // 让纯文本/多模态模型都能看到 image_id 并可 read_raw kind=image 翻完整识别原文
        if (image.rawDescription && image.description && image.rawDescription.length > image.description.length) {
            content += buildImageTruncateMarker(image.rawDescription.length, image.description.length, image.imageId);
        }
        images.push(image);
    } catch (error) {
        log.exception('在handleImageMessage中处理图片时出错', error);
    }

    return { content, images };
}
