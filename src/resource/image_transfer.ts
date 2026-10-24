// 图片发送/展示取值（叶子）：同步 CQ、base64 data-url、模型/发送用 src 与 getSendFile、URL 可达性检查。
// 从 resource/image.ts 拆出——这些取值只依赖 Image 的公共字段与图床接口（ImageHost / seal.base64ToImage，
// 均由宿主提供），实例 getter/method 保留同名委派；便于单测与将来替换图床。
import { logger } from "../logger";

import { ImageHost } from "./image_host";

const log = logger.withTag('image');

/** 取值所需的最小视图（Image 实例结构满足） */
export interface ImageTransferHost {
    imageId: string;
    base64: string;
    format: string;
    url: string;
    path: string;
    hostedId: string;
    hostedUrl: string;
    readonly type: 'url' | 'local' | 'base64';
    /** 是否已入图床（hostedId && ImageHost.enabled） */
    readonly hosted: boolean;
    /** 图床对外绝对地址（不可用时回退原始 url） */
    readonly remoteUrl: string;
}

/** data URL（base64 来源） */
export function base64UrlFor(img: ImageTransferHost): string {
    let format = img.format;
    if (!format || format === 'unknown') format = 'png';
    return `data:image/${format};base64,${img.base64}`;
}

/** 同步版 CQ（只用于本地图展示；外发请用 getSendFile()，hosted 需要异步取字节/判可达性） */
export function cqCodeFor(img: ImageTransferHost): string {
    const file = img.type === 'base64'
        ? seal.base64ToImage(img.base64)
        : (img.hosted
            ? (ImageHost.externalEnabled ? img.remoteUrl : '')
            : (img.url || img.path));
    if (!file) return '';
    return `[CQ:image,file=${file}]`;
}

/** 图片地址：base64 返回 data URL，其余返回 remoteUrl（图床对外地址优先） */
export function srcFor(img: ImageTransferHost): string {
    return img.type === 'base64' ? base64UrlFor(img) : img.remoteUrl;
}

/**
 * 发送给协议端使用的图片值（本地文件路径 / URL）。
 * - 已有字节（base64）→ 本地文件；
 * - 已入图床且对外地址可用（IP/域名）→ 直接给图床稳定地址；
 * - 已入图床但对外地址不可用（回环且没配 publicUrl）→ 取 b64 落成本地文件；
 * - 其余 → 原始 URL / 本地路径。
 * 回环地址不要外发：协议端常在容器/另一台机器，127.0.0.1 指向它自己。
 */
export async function getSendFile(img: ImageTransferHost): Promise<string> {
    if (img.base64) return seal.base64ToImage(img.base64);
    if (img.hosted && ImageHost.externalEnabled) return img.remoteUrl;
    if (img.hosted) {
        const data = await ImageHost.fetchBase64(img.hostedId);
        if (data && data.base64) return seal.base64ToImage(data.base64);
        log.warning(`图片${img.imageId}从图床取字节失败，无法生成本地文件`
            + (ImageHost.lastError ? `：${ImageHost.lastError}` : '')
            + '；请检查图床地址是否可从插件访问');
        // 兜底：原始 http(s) 链接（可能已过期，但总比回环地址强）
        if (img.url && /^https?:\/\//i.test(img.url)) return img.url;
        return '';
    }
    return img.url || img.path;
}

/** URL 可达性检查：仅 url 类型；500 视为"不知道有没有效"按有效处理 */
export async function checkImageUrl(img: ImageTransferHost): Promise<boolean> {
    if (img.type !== 'url') return true;
    let isValid = false;
    try {
        const response = await fetch(img.url, { method: 'GET' });

        if (response.ok) {
            const contentType = response.headers.get('Content-Type');
            if (contentType && contentType.startsWith('image')) {
                log.info('URL有效且未过期');
                isValid = true;
            } else {
                log.warning(`URL有效但未返回图片 Content-Type: ${contentType}`);
            }
        } else {
            if (response.status === 500) {
                log.warning(`URL不知道有没有效 状态码: ${response.status}`);
                isValid = true;
            } else {
                log.warning(`URL无效或过期 状态码: ${response.status}`);
            }
        }
    } catch (error) {
        log.exception('在checkImageUrl中请求出错', error);
    }
    return isValid;
}
