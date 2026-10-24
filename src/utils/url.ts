// URL 工具：不依赖 seal / Config，供配置校验与运行时共用。

/** 还原 URL 中 HTML 转义的 &（QQ 官方 bot 图片常见 &amp;）。只处理 http(s)，最多解 3 轮。 */
export function decodeUrlHtmlEntities(url: string): string {
    let text = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(text)) return text;
    const re = /&(?:amp|#0*38|#x0*26);/gi;
    for (let i = 0; i < 3; i++) {
        const next = text.replace(re, '&');
        if (next === text) break;
        text = next;
    }
    return text;
}

/**
 * 是否回环地址（127.0.0.0/8、localhost、::1、0.0.0.0）。
 *
 * 回环地址只对本机进程可达：QQ 协议端（NapCat，常在容器/另一台机器）与模型（云 API）
 * 都访问不到。对外地址（图床的 publicUrl 等）应当填 IP 或域名。
 * 不依赖 URL 全局对象（goja 里不保证有）。
 */
export function isLoopbackUrl(raw: string): boolean {
    const text = String(raw || '').trim();
    if (!text) return false;
    const m = text.match(/^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/?#:]+)/i);
    if (!m) return false;
    let host = m[1].toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true;
    if (host === '0.0.0.0') return true;
    return /^127\./.test(host);
}
