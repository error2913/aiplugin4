// 图片 URL 健康处置（叶子）：模型侧报告下载失败后，按「图床/非图床」分别标坏或改内联 b64。
// 从 resource/image.ts 拆出——处置逻辑只依赖 imageMap/hostedRefs 与两个回调（save / 本轮内联偏好），
// Image 静态方法保留同名委派；便于单测与将来替换存储。
import type Image from "./image";
import { ImageHost } from "./image_host";

/** 健康处置所需的最小视图（Image 静态注册表提供） */
export interface ImageHealthHost {
    imageMap: { [id: string]: Image };
    hostedRefs: Map<string, { img: Image; at: number }>;
    save(img: Image): void;
    preferInlineForModel(imageId: string): void;
}

/** 模型侧报告无法下载这些 URL 时调用：只处理非图床 URL（图床走 markModelDownloadFailures 探测） */
export function markUrlBrokenByUrls(host: ImageHealthHost, urls: string[]): number {
    const targets = new Set((urls || []).filter(u => u && !u.startsWith('data:')));
    if (targets.size === 0) return 0;
    let marked = 0;
    for (const img of Object.values(host.imageMap)) {
        if (!img || img.base64 || img.urlBroken) continue;
        if (img.hostedId) continue;   // 图床图不能凭模型报错就永久标坏
        const candidate = img.remoteUrl || img.url;
        if (!candidate || !targets.has(candidate)) continue;
        img.urlBroken = true;
        host.save(img);
        marked++;
    }
    return marked;
}

/**
 * 模型报“无法下载图片”时：图床 URL 先探测 404/可达性。
 * - 图床返回 200：图片存在，标记本轮改用内联 b64（不标坏），返回 retryInline=true；
 * - 404：真正已删，标 urlBroken；
 * - 网络错误/不可达：不标坏，留待下轮。
 * 非图床 URL 仍按旧规则标坏。
 */
export async function markModelDownloadFailures(host: ImageHealthHost, urls: string[]): Promise<{ marked: number; retryInline: boolean }> {
    const targets = new Set((urls || []).filter(u => u && !u.startsWith('data:')));
    if (targets.size === 0) return { marked: 0, retryInline: false };
    let marked = 0;
    let retryInline = false;
    const hostedImages: Image[] = [];
    for (const img of Object.values(host.imageMap)) {
        if (!img || img.base64 || img.urlBroken) continue;
        const candidate = img.remoteUrl || img.url;
        if (!candidate || !targets.has(candidate)) continue;
        if (img.hostedId) hostedImages.push(img);
        else {
            img.urlBroken = true;
            host.save(img);
            marked++;
        }
    }
    for (const entry of host.hostedRefs.values()) {
        const img = entry.img;
        if (!img || img.base64 || img.urlBroken) continue;
        const candidate = img.remoteUrl || img.url;
        if (candidate && targets.has(candidate)) hostedImages.push(img);
    }
    for (const img of hostedImages) {
        if (!img.hostedId) continue;
        const data = await ImageHost.fetchBase64(img.hostedId);
        if (data) {
            // 图片还在：本轮改用内联 b64 重发，不标 urlBroken（之后修好 publicUrl 仍可恢复 URL）
            host.preferInlineForModel(img.imageId);
            img.base64 = data.base64;
            img.format = data.format || img.format || 'png';
            img.urlBroken = false;
            retryInline = true;
        } else if (ImageHost.lastStatus === 404) {
            // 图床已彻底删除：与 GC 对账一致，清掉 hosted 字段，发送时不再指向死链
            img.urlBroken = true;
            img.hostedId = '';
            img.hostedUrl = '';
            img.hostedAt = 0;
            img.base64 = '';
            host.save(img);
            marked++;
        }
        // 其它错误（网络/5xx/超时）：不标坏，下一轮再试
    }
    return { marked, retryInline };
}

