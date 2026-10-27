// 图片 URL 健康处置（叶子）：模型侧报告下载失败后，按「图床/非图床」分别标坏或改内联 b64。
// 从 resource/image.ts 拆出——处置逻辑只依赖 imageMap/hostedRefs 与两个回调（save / 本轮内联偏好），
// Image 静态方法保留同名委派；便于单测与将来替换存储。
import Config from "../config/config";

import type Image from "./image";
import { ImageHost } from "./image_host";
import { isHostedImageUrlOf } from "./image_model_source";

/** 健康处置所需的最小视图（Image 静态注册表提供） */
export interface ImageHealthHost {
    imageMap: { [id: string]: Image };
    hostedRefs: Map<string, { img: Image; at: number }>;
    save(img: Image): void;
    preferInlineForModel(imageId: string): void;
}

/** 下载失败返回：本轮是否可改内联；以及无法内联、需要本轮临时排除的图片 id */
export interface DownloadFailureResult {
    marked: number;
    retryInline: boolean;
    excludeIds: string[];
}

/** HTTP 候选地址是否命中本次失败 URL（含图床 /m、/i、b64 三种形态） */
function matchesFailureUrl(img: Image, targets: Set<string>): boolean {
    const candidate = img.remoteUrl || img.url;
    if (candidate && targets.has(candidate)) return true;
    const hostedId = img.hostedId;
    if (!hostedId) return false;
    for (const url of targets) {
        if (isHostedImageUrlOf(url, hostedId)) return true;
    }
    return false;
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
 * 模型报“无法下载图片”时：
 * - 非图床 URL：仍按旧规则标坏（本轮改为文本标签）；
 * - 图床：只允许内联**模型变体**（`/m/<id>/b64`），且受单张字节预算约束；
 *   能内联 → preferInline（本轮改用内联字节）；取不到/超预算 → 返回 excludeIds，由调用方本轮临时排除；
 * - 404：真正已删，标 urlBroken。
 */
export async function markModelDownloadFailures(host: ImageHealthHost, urls: string[]): Promise<DownloadFailureResult> {
    const targets = new Set((urls || []).filter(u => u && !u.startsWith('data:')));
    if (targets.size === 0) return { marked: 0, retryInline: false, excludeIds: [] };
    let marked = 0;
    let retryInline = false;
    const excludeIds: string[] = [];
    const hostedImages: Image[] = [];
    const seen = new Set<string>();
    const collect = (img: Image | null | undefined): void => {
        if (!img || img.base64 || img.urlBroken) return;
        if (seen.has(img.imageId)) return;
        if (!matchesFailureUrl(img, targets)) return;
        if (img.hostedId) {
            seen.add(img.imageId);
            hostedImages.push(img);
        } else {
            img.urlBroken = true;
            host.save(img);
            marked++;
        }
    };
    for (const img of Object.values(host.imageMap)) collect(img);
    for (const entry of host.hostedRefs.values()) collect(entry.img);

    const maxBytes = Math.max(0, Config.image.INLINE_MAX_BYTES_KB) * 1024;
    const targetSide = Math.max(0, Config.image.MODEL_TARGET_SIDE);
    // 后端能力可能因启动时序/升级未探测到：失败恢复路径补一次探测（不在正常选源路径发请求）
    if (hostedImages.length > 0 && !ImageHost.supportsModelVariant) {
        await ImageHost.ensureCapabilities();
    }
    for (const img of hostedImages) {
        if (!img.hostedId) continue;
        const data = await ImageHost.fetchModelBase64(img.hostedId, targetSide);
        if (data && data.base64) {
            const bytes = Math.floor(data.base64.length * 0.75);
            if (maxBytes > 0 && bytes > maxBytes) {
                // 变体也太大：本轮不内联，交给调用方临时排除（避免 413）
                excludeIds.push(img.imageId);
                continue;
            }
            host.preferInlineForModel(img.imageId);
            img.base64 = data.base64;
            const sub = String(data.mime.split('/')[1] || data.format || '').toLowerCase();
            img.format = sub === 'jpg' ? 'jpeg' : (sub || img.format || 'png');
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
        } else {
            // 网络/5xx/超时：本轮临时排除（下次重试），不永久标坏
            excludeIds.push(img.imageId);
        }
    }
    return { marked, retryInline, excludeIds };
}
