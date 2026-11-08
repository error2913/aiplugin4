// 图片 URL 健康判定（叶子，纯函数）：QQ 临时直链域名识别、后端 4xx 永久失败识别。
// 从 resource/image.ts 拆出——判定只依赖 URL/错误正文，与图片实体/存储解耦。
const TEMPORARY_IMAGE_URL_HOSTS = [
    'multimedia.nt.qq.com.cn',
    'multimedia.nt.qq.com',
    'gchat.qpic.cn',
    'c2cpicdw.qpic.cn',
    'c2cpic.qpic.cn',
];

/** QQ 图床等带 rkey 的临时直链：到手后很快失效，模型侧往往也下载不到，不宜作为 image_url 交给模型 */
export function isTemporaryUrl(url: string): boolean {
    if (!url) return false;
    if (/[?&]rkey=/i.test(url)) return true;
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch (_e) {
        return false;
    }
    return TEMPORARY_IMAGE_URL_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

/** 可重试的 HTTP 状态：408 超时、425 Too Early、429 限速（其余 4xx 视为 URL 永久失效） */
export const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([408, 425, 429]);

/** 该 HTTP 状态是否属于「URL 永久失效」（4xx 且非可重试类） */
export function isPermanentHttpStatus(status: number): boolean {
    const code = Number(status) || 0;
    if (code < 400 || code >= 500) return false;
    return !TRANSIENT_HTTP_STATUS.has(code);
}

/**
 * 转换失败是否属于「该 URL 已不可用」的永久性失败：后端会把上游下载被 4xx 拒绝的原因写进错误正文
 * （如 "400 Client Error: Bad Request for url: ..."、QQ 的 download url has expired），重试没有意义；
 * 429 限速与 5xx 仍按可重试处理。
 */
export function isPermanentUrlError(text: string): boolean {
    if (/url has expired|retcode["'\s:]*-\s*5503007/i.test(text)) return true;
    const m = text.match(/\b(4\d{2})\s+Client Error\b/i);
    if (m && isPermanentHttpStatus(Number(m[1]))) return true;
    // 图床等后端返回结构化错误：{"error":"fetch_failed","upstream_status":400,...}
    const status = text.match(/upstream_status["'\s:]+(4\d{2})/i);
    return !!status && isPermanentHttpStatus(Number(status[1]));
}
