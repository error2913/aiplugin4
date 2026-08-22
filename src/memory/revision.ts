// 记忆缓存版本：记忆/总结内容变更后自增，并主动失效对应 prompt 缓存。
// 使用全局版本而非逐实例版本，因为一次总结可能写入多个会话的记忆，任何写入都应刷新所有相关缓存。
import { invalidateCachedPrefix } from "../prompt/prompt_cache";

let memoryRevision = 0;
let summaryRevision = 0;

export function getMemoryRevision(): number {
    return memoryRevision;
}

export function bumpMemoryRevision(): void {
    memoryRevision++;
    invalidateCachedPrefix('prompt:memory|');
}

export function getSummaryRevision(): number {
    return summaryRevision;
}

export function bumpSummaryRevision(): void {
    summaryRevision++;
    invalidateCachedPrefix('prompt:summary|');
}
