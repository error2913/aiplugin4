// 记忆条目的模型可见引用格式（叶子）：`[mem:<id>]`。
//
// 目的：让模型能把注入的记忆条目原样交给 resolve_context_ref / memory_* 工具，
// 不必猜测裸 base36 ID 是消息还是记忆。这里只做字符串格式化/归一，不读写存储。
const MEM_REF_RE = /^\[?\s*mem\s*[:：]\s*([^\]\s]+)\s*\]?$/i;

/** 注入用的引用前缀；id 为空时返回空串（调用方保留原前缀，如 `- ` / `1. `） */
export function memoryHandle(id: unknown): string {
    const value = String(id ?? '').trim();
    return value ? `[mem:${value}] ` : '';
}

/** 把 `[mem:id]` / `mem:id` / 裸 id 归一为裸 id；无法识别时原样 trim 返回 */
export function normalizeMemoryRef(raw: unknown): string {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    const m = MEM_REF_RE.exec(text);
    return m ? m[1].trim() : text;
}
