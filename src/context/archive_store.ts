
import { getHost } from "../core/host";
// 归档/原文分片存储：把"移出上下文"的群聊原文按批写进独立 key，供 read_raw / grep_raw 按需回查。
//
// 为什么是分片而不是塞回 session：
// - 海豹的 ext.storageSet 是**叠加式**存储（写同样的内容也占新空间），把归档内容留在 session 里，
//   每次 save 都会把整段历史重写一遍；分片只在移出时**写一次**，之后永不重写（增量、幂等）。
// - 项目内先例：src/memory/v2/storage.ts 把一个记忆库拆成 meta/units/links/docs/obs 五个 key，只写变化的那份；
//   删除用 storageSet(key, '') 置空（海豹没有 delete/list API，types/seal.d.ts:502-504）。
//
// 键名：session_<会话ID>:<kind>:<三位序号>（如 session_QQ-Group:123:arc:001）
// 两种 kind 的语义区分（docs/03 上下文/分片模块）：
//   - `arc` = **归档**（token 超限触发，`archiveSeq` 水位）
//   - `raw` = **窗口移出**（窗口上限触发，`rawSeq` 水位）
// 二者都只是"原文留档"，对模型不可见，共用同一套读写函数（键前缀参数化）。

/** 分片种类：arc=归档（token 超限）/ raw=窗口移出（窗口上限） */
export type ShardKind = 'arc' | 'raw';

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
    /** 本批是否已完成记忆结算（raw 分片用；docs/03 上下文/分片模块 的水位幂等辅助标记） */
    settled?: boolean;
}

/** 分片数量上限：超过则把最旧的分片置空（海豹无删除 API，置空即项目内先例做法） */
export const ARCHIVE_SHARD_LIMIT = 200;

export function shardKey(sessionId: string, seq: number, kind: ShardKind = 'arc'): string {
    return `session_${sessionId}:${kind}:${String(seq).padStart(3, '0')}`;
}

/** 读取分片；不存在或解析失败返回 null（海豹 storageGet 在 key 不存在时**必然**抛异常，统一兜住） */
export function readShard(sessionId: string, seq: number, kind: ShardKind = 'arc'): ArchiveShard | null {
    if (!sessionId || seq <= 0) return null;
    try {
        const raw = getHost().storage.get(shardKey(sessionId, seq, kind));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed as ArchiveShard;
    } catch {
        return null;
    }
}

/**
 * 写入分片；**已存在则跳过**（幂等：同一批重试/并发不会重复写）。
 *
 * 实现要点（B1）：**不能用"读分片本体是否抛异常"来判断存在性**。
 * 海豹 `storageGet` 的契约是"key 不存在**或**失败时抛异常"（types/seal.d.ts:504），
 * 因此"不存在"与"读失败"在异常层面**不可区分**：
 *   - 若把读异常一律当"不存在"→ 真实读失败时会覆盖既有分片（原缺陷）；
 *   - 若把读异常一律当 'failed' → **每个新分片的首次写入都会失败**（不存在必然抛异常），归档永久卡死。
 * 两个目标只能靠**与分片本体解耦的存在性判据**同时满足：调用方传入已知的存在性事实
 * （`knownExists`，即持久化的 `archiveSeq`/`rawSeq` 水位）——它由 session 存档维护，不依赖读分片本体。
 *
 * @param knownExists 调用方已知该 seq 已被写入过（`seq <= 已持久化的水位`）。传 true 则直接跳过写入。
 * @returns 'written' 新写入 / 'exists' 已存在（内容已在盘上，可安全移除来源）/ 'failed' 写入失败（**调用方不得移除来源**）
 */
export function writeShardIfAbsent(
    sessionId: string,
    seq: number,
    shard: ArchiveShard,
    knownExists = false,
    kind: ShardKind = 'arc',
): 'written' | 'exists' | 'failed' {
    if (!sessionId || seq <= 0) return 'failed';
    // 存在性判据来自调用方的持久化水位，而非"读分片本体"——见上方说明。
    if (knownExists) return 'exists';
    const key = shardKey(sessionId, seq, kind);
    // 读一次做尽力而为的重复写入防护：读到内容 → 确实已存在（可安全移除来源）；
    // 抛异常 → 无法区分"不存在"与"读失败"，**按不存在继续写入**（否则新分片永远写不进去）。
    // 真正的覆盖防护由 knownExists 水位承担；此处只处理"水位落后于实际分片"的窄缝。
    try {
        if (getHost().storage.get(key)) return 'exists';
    } catch {
        // 见上：不存在是常态（必然抛异常），继续写入
    }
    try {
        getHost().storage.set(key, JSON.stringify(shard));
        return 'written';
    } catch {
        return 'failed';
    }
}

/** 置空一个分片（超出上限时的清理手段） */
export function clearShard(sessionId: string, seq: number, kind: ShardKind = 'arc'): void {
    if (!sessionId || seq <= 0) return;
    try {
        getHost().storage.set(shardKey(sessionId, seq, kind), '');
    } catch {
        // 清理失败不影响主流程
    }
}

/**
 * 置空某会话某类分片的 1..maxSeq（旧清理/测试用）。
 * @returns 实际置空的分片数（按读到的有效分片计，避免把"本来就没有的序号"也算进去）
 */
export function clearShardsFor(sessionId: string, kind: ShardKind, maxSeq: number): number {
    if (!sessionId || maxSeq <= 0) return 0;
    let cleared = 0;
    for (let seq = 1; seq <= maxSeq; seq++) {
        if (readShard(sessionId, seq, kind)) cleared++;
        clearShard(sessionId, seq, kind);
    }
    return cleared;
}

/**
 * 从新到旧列出分片（供 read_raw / grep_raw 回查）。
 * @param maxSeq 当前已写入的最大序号（session 的对应水位）
 * @param limit 最多读取的分片数（grep 默认只扫最近若干个，避免慢）
 */
export function listShardsDesc(sessionId: string, maxSeq: number, limit: number, kind: ShardKind = 'arc'): ArchiveShard[] {
    const out: ArchiveShard[] = [];
    if (!sessionId || maxSeq <= 0 || limit <= 0) return out;
    for (let seq = maxSeq; seq >= 1 && out.length < limit; seq--) {
        const shard = readShard(sessionId, seq, kind);
        if (shard) out.push(shard);
    }
    return out;
}

/** 从旧到新列出分片（结算按 `settledSeq+1 .. rawSeq` 顺序处理，docs/03 上下文/分片模块） */
export function listShardsAsc(sessionId: string, fromSeq: number, toSeq: number, limit: number, kind: ShardKind = 'raw'): ArchiveShard[] {
    const out: ArchiveShard[] = [];
    if (!sessionId || toSeq <= 0 || limit <= 0) return out;
    const start = Math.max(1, fromSeq);
    for (let seq = start; seq <= toSeq && out.length < limit; seq++) {
        const shard = readShard(sessionId, seq, kind);
        if (shard) out.push(shard);
    }
    return out;
}

/**
 * 惰性 TTL 淘汰：把 `from` 早于 `now - ttlDays` 的分片置空（docs/03 上下文/分片模块）。
 * 惰性＝不额外起定时器，只在"访问某会话分片"时顺带做一次，避免后台任务与重载后状态丢失。
 * @returns 实际淘汰的分片数
 */
export function evictExpiredShards(sessionId: string, kind: ShardKind, maxSeq: number, ttlDays: number, nowSec: number): number {
    if (!sessionId || maxSeq <= 0 || ttlDays <= 0) return 0;
    const cutoff = nowSec - ttlDays * 86400;
    let evicted = 0;
    for (let seq = 1; seq <= maxSeq; seq++) {
        const shard = readShard(sessionId, seq, kind);
        if (!shard) continue;
        // from<=0 视为"时间未知"，不淘汰（宁可多留，也不误删无时间戳的旧数据）
        if (shard.from > 0 && shard.from < cutoff) {
            clearShard(sessionId, seq, kind);
            evicted++;
        }
    }
    return evicted;
}
