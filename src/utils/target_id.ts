/** 目标用户/群 ID 规范化：只接受 QQ 号、群号或统一会话 ID，不接受名称。 */

function normalizeRawId(value: string | number): string {
    return String(value ?? '').trim();
}

function normalizeNumericId(value: string): string | null {
    return /^\d+$/.test(value) ? value : null;
}

export function normalizeUserId(value: string | number): string | null {
    const id = normalizeRawId(value);
    if (!id) return null;
    if (id.startsWith('QQ:')) {
        const rawId = normalizeNumericId(id.slice(3));
        return rawId ? `QQ:${rawId}` : null;
    }
    const rawId = normalizeNumericId(id);
    return rawId ? `QQ:${rawId}` : null;
}

export function normalizeGroupId(value: string | number): string | null {
    const id = normalizeRawId(value);
    if (!id) return null;
    if (id.startsWith('QQ-Group:')) {
        const rawId = normalizeNumericId(id.slice('QQ-Group:'.length));
        return rawId ? `QQ-Group:${rawId}` : null;
    }
    const rawId = normalizeNumericId(id);
    return rawId ? `QQ-Group:${rawId}` : null;
}

/** 规范化需要同时支持用户和群的目标 ID；裸数字不接受，因为无法判断目标类型。 */
export function normalizeTargetId(value: string | number): string | null {
    const id = normalizeRawId(value);
    if (id.startsWith('QQ-Group:')) return normalizeGroupId(id);
    if (id.startsWith('QQ:')) return normalizeUserId(id);
    return null;
}

export function getRawId(id: string): string {
    return id.replace(/^.+:/, '');
}
