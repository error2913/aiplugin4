// Context v2 存储键命名（纯函数）。
// 设计要点：evt/rec 都用连续页号，键名本身即枚举清单；不保存任意 key 名。
import { CONTEXT_SCHEMA_VERSION } from "./events";

/** 页号固定 6 位，按数字递增；不使用字符串比较做枚举 */
export const PAGE_NO_WIDTH = 6;

export function padPageNo(pageNo: number): string {
    return String(Math.max(0, Math.floor(pageNo))).padStart(PAGE_NO_WIDTH, '0');
}

/** 会话头：水位/页号范围/epoch/字节数（很小，每次 flush 重写） */
export function headKey(sessionId: string): string {
    return `ctx_head:${sessionId}`;
}

/** 事件页：只写一次，不复写 */
export function eventPageKey(sessionId: string, pageNo: number): string {
    return `evt:${sessionId}:${padPageNo(pageNo)}`;
}

/** 记录页：summary/edit/supersede/redact/epoch 统一放这里 */
export function recordPageKey(sessionId: string, pageNo: number): string {
    return `rec:${sessionId}:${padPageNo(pageNo)}`;
}

/** 大内容分块（base64/超大工具输出），事件里只存引用 */
export function blobKey(sessionId: string, seq: number, part: number): string {
    return `blob:${sessionId}:${seq}:${part}`;
}

/** 旧版归档/窗口分片键（迁移期只读兼容） */
export function legacyShardKey(sessionId: string, kind: 'arc' | 'raw', seq: number): string {
    return `session_${sessionId}:${kind}:${String(seq).padStart(3, '0')}`;
}

/** 旧版会话主体键（迁移期只读） */
export function legacySessionKey(sessionId: string): string {
    return `session_${sessionId}`;
}

export function contextSchemaVersion(): number {
    return CONTEXT_SCHEMA_VERSION;
}
