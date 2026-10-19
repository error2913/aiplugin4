// URL 工具：不依赖 seal / Config，供配置校验与运行时共用。

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
