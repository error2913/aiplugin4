// 图片识别（叶子）：多模态模型识图 → description（超长时截断展示、完整原文进 rawDescription）。
// 从 resource/image.ts 拆出——识别只依赖图床接口、模型与 Image 的取值/回调（save、urlToBase64、getModelSrc），
// Image.imageToText 保留同名委派；便于单测与替换识别链路。
import Config from "../config/config";
import { logger } from "../logger";
import Model from "../model/model";

import { ImageHost } from "./image_host";

const log = logger.withTag('image');

/** 识别所需的最小视图（Image 实例结构满足） */
export interface ImageTextHost {
    imageId: string;
    urlBroken: boolean;
    base64: string;
    format: string;
    description: string;
    rawDescription: string;
    hostedId: string;
    readonly hosted: boolean;
    readonly type: 'url' | 'local' | 'base64';
    readonly isAvatarImage: boolean;
    readonly src: string;
    readonly base64Url: string;
    isBase64RetryBlocked(): boolean;
    /** 默认识图提示词（由宿主渲染，避免本叶子依赖 prompt 层） */
    defaultPrompt(): string;
    urlToBase64(): Promise<void>;
    getModelSrc(model?: { baseUrl?: string }): Promise<string>;
    /** 持久化当前图片字段（等价 Image.save(this)） */
    saveSelf(): void;
}

/** 图片转文字结果超长时不再交给压缩智能体，改为只展示开头 N 字并把完整原文存入 rawDescription */
export function truncateIfLong(host: Pick<ImageTextHost, 'rawDescription'>, text: string): string {
    const { IMAGE_TEXT_TRUNCATE_CHARS } = Config.image;
    if (!text) return text;
    if (IMAGE_TEXT_TRUNCATE_CHARS > 0 && text.length > IMAGE_TEXT_TRUNCATE_CHARS) {
        host.rawDescription = text;
        return text.slice(0, IMAGE_TEXT_TRUNCATE_CHARS);
    }
    return text;
}

export async function imageToText(host: ImageTextHost, prompt = ''): Promise<void> {
    const { URL_TO_BASE64 } = Config.image;
    const defaultPrompt = host.defaultPrompt();

    const model = Model.getMultimodalModel('image-understanding');
    if (!model) {
        log.error(`未找到支持image-understanding的模型`);
        return;
    }

    // URL 已确认不可用（QQ 直链过期等）：识图模型同样下载不到，不再白花一次请求
    if (host.urlBroken) {
        log.warning(`图片${host.imageId}的URL已确认不可用，跳过识图`);
        host.saveSelf();
        return;
    }

    // 图床/头像：交给 getModelSrc 统一选择 URL 或 b64（模型可达性判断）
    // 非图床 URL：保持旧行为（“总是”先转 b64；配了图床时先入库再取 b64）
    let src = '';
    if (host.hosted || host.isAvatarImage) {
        src = await host.getModelSrc(model);
    } else {
        if (URL_TO_BASE64 == '总是' && host.type === 'url' && !host.isBase64RetryBlocked()) await host.urlToBase64();
        if (ImageHost.enabled && host.type === 'url' && !host.base64) await host.urlToBase64();
        // 取不到 b64 时保留旧行为：把原始/稳定 URL 交给识图模型（图床失败不阻断识图）
        src = host.base64 ? host.base64Url : host.src;
    }
    if (!src) {
        log.warning(`图片${host.imageId}取不到可用的识图地址（图床不可达/图片已删），跳过识图`);
        host.saveSelf();
        return;
    }

    host.description = truncateIfLong(host, await model.callITT(src, prompt ? prompt : defaultPrompt));

    // 图床：首次给了 URL 但模型没识别出来 → 用 b64 再试一次（不依赖“自动”配置；宁可多一次本地请求）
    if (!host.description && host.hosted && host.hostedId) {
        const data = await ImageHost.fetchBase64(host.hostedId);
        if (data) {
            host.base64 = data.base64;
            host.format = data.format || host.format || 'png';
            host.description = truncateIfLong(host, await model.callITT(host.base64Url, prompt ? prompt : defaultPrompt));
        }
    }

    if (!host.description && URL_TO_BASE64 === '自动' && host.type === 'url' && !host.isBase64RetryBlocked()) {
        log.info(`图片${host.imageId}第一次识别失败，自动尝试使用转换为base64`);
        await host.urlToBase64();
        if (host.base64) {
            host.description = truncateIfLong(host, await model.callITT(host.base64Url, prompt ? prompt : defaultPrompt));
        }
    }

    if (!host.description) log.error(`图片${host.imageId}识别失败`);
    else host.saveSelf(); // 持久化 description/rawDescription（含截断时保留的完整识别原文）
}
