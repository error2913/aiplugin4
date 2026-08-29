/**
 * 目标用户/群 ID 规范化：平台无关。
 * 支持任意平台前缀（如 QQ:、QQ-Group:、DISCORD:、OpenQQ-Group:），
 * 裸 ID（无前缀）时必须由调用方通过 platformHint 提供平台（通常来自 ctx.endPoint.platform），
 * 否则返回 null。绝不默认 QQ。
 * 群 ID 使用海豹通用标记「-Group:」判定，兼容 OpenQQ 等平台。
 */

function normalizeRawId(value: string | number): string {
    return String(value ?? '').trim();
}

/** QQ 平台裸 ID 仍要求纯数字；其它平台按原样保留。 */
function normalizeNumericId(value: string): string | null {
    return /^\d+$/.test(value) ? value : null;
}

/** 取平台名：QQ:123 → QQ，QQ-Group:123 → QQ，DISCORD:abc → DISCORD。 */
export function getPlatform(id: string): string {
    const idStr = String(id ?? '');
    const prefix = idStr.includes(':') ? idStr.slice(0, idStr.indexOf(':')) : idStr;
    return prefix.endsWith('-Group') ? prefix.slice(0, -'-Group'.length) : prefix;
}

/** 拼用户 UNI-ID：QQ + 123 → QQ:123。 */
export function makeUserId(platform: string, raw: string | number): string {
    return `${platform}:${raw}`;
}

/** 拼群 UNI-ID：QQ + 123 → QQ-Group:123。 */
export function makeGroupId(platform: string, raw: string | number): string {
    return `${platform}-Group:${raw}`;
}

/** 判断 UNI-ID 是否为群 ID（含 -Group: 标记）。 */
export function isGroupId(id: string): boolean {
    return String(id ?? '').includes('-Group:');
}

function normalizePlatformHint(platformHint?: string): string | null {
    const platform = String(platformHint ?? '').trim();
    if (!platform) return null;
    return platform.endsWith('-Group') ? platform.slice(0, -'-Group'.length) : platform;
}

export function normalizeUserId(value: string | number, platformHint?: string): string | null {
    const id = normalizeRawId(value);
    if (!id) return null;
    const colon = id.indexOf(':');
    if (colon > 0) {
        // 带前缀：任意平台原样保留；群 ID 不能当用户 ID
        const prefix = id.slice(0, colon);
        if (prefix.endsWith('-Group')) return null;
        const rawId = id.slice(colon + 1);
        if (!rawId) return null;
        if (prefix === 'QQ') {
            const numeric = normalizeNumericId(rawId);
            return numeric ? `QQ:${numeric}` : null;
        }
        return `${prefix}:${rawId}`;
    }
    // 裸 ID：需要平台 hint 补全，无 hint 返回 null
    const platform = normalizePlatformHint(platformHint);
    if (!platform) return null;
    if (platform === 'QQ') {
        const rawId = normalizeNumericId(id);
        return rawId ? `QQ:${rawId}` : null;
    }
    return `${platform}:${id}`;
}

export function normalizeGroupId(value: string | number, platformHint?: string): string | null {
    const id = normalizeRawId(value);
    if (!id) return null;
    const colon = id.indexOf(':');
    if (colon > 0) {
        const prefix = id.slice(0, colon);
        const rawId = id.slice(colon + 1);
        if (!rawId) return null;
        if (prefix.endsWith('-Group')) {
            const platform = prefix.slice(0, -'-Group'.length);
            if (platform === 'QQ') {
                const numeric = normalizeNumericId(rawId);
                return numeric ? `QQ-Group:${numeric}` : null;
            }
            return `${platform}-Group:${rawId}`;
        }
        // 用户 ID 前缀不能当群 ID
        return null;
    }
    const platform = normalizePlatformHint(platformHint);
    if (!platform) return null;
    if (platform === 'QQ') {
        const rawId = normalizeNumericId(id);
        return rawId ? `QQ-Group:${rawId}` : null;
    }
    return `${platform}-Group:${id}`;
}

/** 规范化需要同时支持用户和群的目标 ID；裸 ID 不接受，因为无法判断目标类型。 */
export function normalizeTargetId(value: string | number, platformHint?: string): string | null {
    const id = normalizeRawId(value);
    if (!id) return null;
    if (id.includes('-Group:')) return normalizeGroupId(id, platformHint);
    if (id.includes(':')) return normalizeUserId(id, platformHint);
    return null;
}

/**
 * 从消息上下文推导平台名：优先 endPoint.platform，其次从 endPoint.userId 前缀解析。
 * 不依赖 seal 类型，仅取所需字段。
 */
export function platformOf(ctx: { endPoint?: { platform?: string; userId?: string } } | null | undefined): string {
    return String(ctx?.endPoint?.platform || '').trim() || getPlatform(ctx?.endPoint?.userId || '');
}

export function getRawId(id: string): string {
    return id.replace(/^.+:/, '');
}
