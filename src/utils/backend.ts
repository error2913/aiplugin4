// 后端访问公共工具：token 请求头与 401 可操作提示。
//
// 所有 aiplugin4-backends 后端都读取 AIPLUGIN4_BACKEND_TOKEN，校验
// `Authorization: Bearer <token>` 或 `X-Token: <token>`；插件统一发前者，token 为空则不加头。

/** 后端访问 token → 请求头；空 token 不带头（兼容未启用鉴权的默认部署） */
export function backendAuthHeaders(token?: string | null): Record<string, string> {
    const t = String(token ?? '').trim();
    return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 401 时可操作提示：指向「后端配置」JSON 的字段名（复制后端配置可一并带上 token） */
export function backendAuthHint(backendName: string): string {
    return `401：该后端启用了访问 token。请在 aiplugin4-backends 点「📋 复制后端配置」重新粘贴`
        + `（确认 backends.${backendName}.token 与后端卡片「⚙ 配置」里的 token 一致；改 token 后需重启该后端）`;
}

/** 非 2xx 时给日志/报错追加提示：仅 401 需要给操作指引 */
export function backendStatusHint(status: number, backendName: string): string {
    return status === 401 ? `\n${backendAuthHint(backendName)}` : '';
}
