// 归档分片存储：把"移出上下文"的群聊原文按批写进独立 key，供 read_raw / grep_raw 按需回查。
//
// 为什么是分片而不是塞回 session：
// - 海豹的 ext.storageSet 是**叠加式**存储（写同样的内容也占新空间），把归档内容留在 session 里，
//   每次 save 都会把整段历史重写一遍；分片只在归档时**写一次**，之后永不重写（增量、幂等）。
// - 项目内先例：src/memory/v2/storage.ts 把一个记忆库拆成 meta/units/links/docs/obs 五个 key，只写变化的那份；
//   删除用 storageSet(key, '') 置空（海豹没有 delete/list API，types/seal.d.ts:502-504）。
//
// 键名：session_<会话ID>:arc:<三位序号>（如 session_QQ-Group:123:arc:001）
import { ext } from "../config/config";

/** 分片内的一条原文（与 rawItems 条目同构） */
export interface ArchiveShardItem {
    messageId: string;
    userId: string;
    time: number;
    text: string;
}

/** 一批归档内容 */
export interface ArchiveShard {
    seq: number;
    /** 本批最早/最晚时间（秒），便于目录展示 */
    from: number;
    to: number;
    items: ArchiveShardItem[];
    /** 本批 summarize 抽出的事实（可选，便于只读回查） */
    facts?: string[];
}

/** 分片数量上限：超过则把最旧的分片置空（海豹无删除 API，置空即项目内先例做法） */
export const ARCHIVE_SHARD_LIMIT = 200;

export function shardKey(sessionId: string, seq: number): string {
    return `session_${sessionId}:arc:${String(seq).padStart(3, '0')}`;
}

/** 读取分片；不存在或解析失败返回 null（海豹 storageGet 在 key 不存在时可能抛异常，统一兜住） */
export function readShard(sessionId: string, seq: number): ArchiveShard | null {
    if (!sessionId || seq <= 0) return null;
    try {
        const raw = ext.storageGet(shardKey(sessionId, seq));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed as ArchiveShard;
    } catch {
        return null;
    }
}

/**
 * 写入分片；**已存在则跳过**（幂等：同一批归档重试/并发不会重复写）。
 * @returns 是否真的新写入了
 */
export function writeShardIfAbsent(sessionId: string, seq: number, shard: ArchiveShard): boolean {
    if (!sessionId || seq <= 0) return false;
    const key = shardKey(sessionId, seq);
    try {
        if (ext.storageGet(key)) return false;
    } catch {
        // 读取异常按"不存在"处理，继续写入（避免因读失败而丢归档）
    }
    try {
        ext.storageSet(key, JSON.stringify(shard));
        return true;
    } catch {
        return false;
    }
}

/** 置空一个分片（超出上限时的清理手段） */
export function clearShard(sessionId: string, seq: number): void {
    if (!sessionId || seq <= 0) return;
    try {
        ext.storageSet(shardKey(sessionId, seq), '');
    } catch {
        // 清理失败不影响主流程
    }
}

/**
 * 从新到旧列出分片（供 read_raw / grep_raw 回查）。
 * @param maxSeq 当前已写入的最大序号（session.archiveSeq）
 * @param limit 最多读取的分片数（grep 默认只扫最近若干个，避免慢）
 */
export function listShardsDesc(sessionId: string, maxSeq: number, limit: number): ArchiveShard[] {
    const out: ArchiveShard[] = [];
    if (!sessionId || maxSeq <= 0 || limit <= 0) return out;
    for (let seq = maxSeq; seq >= 1 && out.length < limit; seq--) {
        const shard = readShard(sessionId, seq);
        if (shard) out.push(shard);
    }
    return out;
}
