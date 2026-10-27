// 多消息分隔符（叶子模块）：内置 \f + 「额外消息分隔符」模板配置的解析与拆分正则。
// 纯函数，不依赖 Config / seal / 其它业务模块，避免为解析一个配置拉进依赖环。
// 约定：\f 是内置多消息分隔符（内部拼接与 quote/poke 边界也用它），模板配置只「追加」额外分隔符。
// 模板每框一条；空串视为未填写。用户填转义写法（如 \n\n / \n），这里解码成真实字符。

/** 模板值 → 额外分隔符真实字符列表（解码 \n/\r 转义、去空、去重） */
export function resolveExtraSeparators(raw?: string[]): string[] {
    if (!Array.isArray(raw)) return [];
    const result = new Set<string>();
    for (const item of raw) {
        const decoded = String(item ?? '').trim()
            .replace(/\\r\\n/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\n');
        if (decoded) result.add(decoded);
    }
    return [...result];
}

/** 模板值 → 提示词里展示的写法（保留转义原文、去空、去重） */
export function extraSeparatorLabels(raw?: string[]): string[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map(item => String(item ?? '').trim()).filter(Boolean))];
}

/**
 * 拆分用正则片段（不带分组）：内置 \f（真实字符 + 反斜杠字面量，quote/poke 结构标记也依赖它），
 * 以及每个额外分隔符（真实字符 + 模板原文，模型两种写法都可能输出）。
 */
export function messageSeparatorSplitPattern(raw?: string[]): string {
    const patterns = new Set(['\f', '\\f']);
    extraSeparatorLabels(raw).forEach(label => patterns.add(label));
    resolveExtraSeparators(raw).forEach(real => patterns.add(real));
    return [...patterns].map(escapeRegExp).join('|');
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
