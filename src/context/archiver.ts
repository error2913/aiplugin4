// 上下文归档与窗口移出：L1 窗口裁剪（trimToWindow）+ L2 记忆结算（archiveByTokenIfNeeded/settleWindowIfNeeded）。
// 从 context.ts 拆出：只依赖 host.messages / host.session + 分片存储，与消息增删（Context 主体）解耦；
// 关键不变量集中在本文件：写分片成功才移除、工具配对原子组不拆、归档失败不做硬删（连续失败才降级）。
import Config from "../config/config";
import Logger from "../logger";
import { MemoryManager } from "../memory/manager";
import { resolveEffectiveMaxTokens } from "../model/api_error";
import Model from "../model/model";
import { getProbedContextWindow } from "../model/window_cache";
import type { Session } from "../session/session";
import { buildContent, estimateMessageTokens, toolResultCallId } from "../utils/message";
import { stripRawMarkers } from "../utils/raw_marker";

import { ArchiveShardItem, clearShard, evictExpiredShards, listShardsAsc, writeShardIfAbsent } from "./archive_store";
import Message from "./message";
import { ARCHIVE_FAIL_LIMIT, runtimeOf } from "./runtime";
import { MessageType, UserMessage, UserMessageItem } from "./types";
import { dropOldestRound, estimateContextMessagesTokens, getKeepStart, splitMessagesByToken } from "./window_policy";

const log = Logger.withTag('context');

/** 归档分块 token 预算：避免单次总结上下文过大 */
export const ARCHIVE_CHUNK_TOKENS = 50000;

/** 归档/窗口函数只需 messages 与 session（结构化匹配 Context，不 import 其实现） */
export interface ArchiveHost {
    messages: MessageType[];
    session: Session;
}

/** 每个 host 的「归档在飞」锁（WeakSet，不持久化；替代原 Context.archiving 字段） */
const archivingHosts = new WeakSet<object>();

    /**
     * L2 记忆结算（P1-3，docs/03 上下文/分片模块）：把窗口外原文（`raw:`/`arc:` 分片）总结进长期记忆。
     *
     * 为什么需要：记忆沉淀原本只在 `archiveByTokenIfNeeded` 触发，而它的门槛是
     * `上下文最大token`（默认 100 万）→ 实际几乎不触发，待机群历史基本不进长期记忆。
     *
     * **触发（三条件同时成立）**：
     *   ① 待结算积压 ≥ 结算水位；② 上下文总量 ≥ 结算最小门槛；
     *   ③ 距上次相关活动 ≥ 结算空闲门槛，**或** 状态已转入 COLD（转冷时结算一次）。
     *
     * **执行**：从 `raw:` 分片按序号升序读回未结算原文 → `summarizeChunkWithRetry`
     * 抽 facts 写记忆库；成功后推进 `settledSeq` 水位（天然幂等：只处理 `settledSeq+1 .. rawSeq`）。
     *
     * **上限与退避**：单次最多处理 `单次结算调用上限` 个分片；失败按会话指数退避 5/15/60 分钟。
     *
     * @returns 本次实际结算的分片数（0 表示未触发/无积压/失败）
     */
export async function settleWindowIfNeeded(host: ArchiveHost, now: number = Date.now()): Promise<number> {
        const { SETTLE_WATERMARK, SETTLE_MIN_TOKENS, SETTLE_IDLE_SEC, SETTLE_MAX_SHARDS } = Config.context;
        if (SETTLE_WATERMARK <= 0 || SETTLE_MAX_SHARDS <= 0) return 0;   // 水位 0 = 关闭自动结算
        const s: any = host.session;
        if (!s || !s.sessionId) return 0;

        const rawSeq = typeof s.rawSeq === 'number' ? s.rawSeq : 0;
        const settledSeq = typeof s.settledSeq === 'number' ? s.settledSeq : 0;
        if (rawSeq <= settledSeq) return 0;   // 没有未结算的分片

        // 退避中：直接跳过，不消耗任何调用
        if (typeof s.settleBackoffUntil === 'number' && now < s.settleBackoffUntil) return 0;

        // ① 待结算积压（token）：**必须按"全部未结算分片"计，而不是按本次要处理的那几个**。
        // 反例（真实缺陷，已被 testSettleBacklogAcrossManySmallShards 固化）：积压分散在 50 个小分片里，
        // 总量远超水位，但单次只看前 2 片 → 每片都不够水位 → **永不结算**，历史永远进不了长期记忆。
        // 「单次结算调用上限」限制的是**本次处理几个**，不是"积压怎么算"。
        const allPending = listShardsAsc(s.sessionId, settledSeq + 1, rawSeq, Number.MAX_SAFE_INTEGER, 'raw');
        if (allPending.length === 0) {
            // 分片被清理/读不到：推进水位，避免每次都空转重试
            s.settledSeq = rawSeq;
            return 0;
        }
        const tokensOf = (shards: typeof allPending) => shards.reduce((sum, shard) =>
            sum + shard.items.reduce((n, it) => n + estimateMessageTokens({ role: 'user', contentItems: [{ text: it.text }] } as any), 0), 0);
        if (tokensOf(allPending) < SETTLE_WATERMARK) return 0;

        // 本次实际处理的分片（按序号升序，受单次上限约束）
        const pending = allPending.slice(0, SETTLE_MAX_SHARDS);

        // ② 上下文总量门槛
        if (estimateContextMessagesTokens(host.messages) < SETTLE_MIN_TOKENS) return 0;

        // ③ 空闲门槛 **或** 已转冷
        const state = typeof s.stateOf === 'function' ? s.stateOf(now, { touch: false }) : 'HOT';
        const idleSec = s.lastRelevantAt > 0 ? Math.max(0, now - s.lastRelevantAt) / 1000 : Infinity;
        if (state !== 'COLD' && SETTLE_IDLE_SEC > 0 && idleSec < SETTLE_IDLE_SEC) return 0;

        // 执行：逐个分片 summarize（各自独立成败，成功一个推进一格水位）
        let done = 0;
        for (const shard of pending) {
            const messages = shard.items.map(it => ({ role: 'user', contentItems: [{ text: it.text, time: it.time, userId: it.userId, messageId: it.messageId }] }));
            let ok = false;
            try {
                ok = await MemoryManager.summarizeChunkWithRetry(host.session, messages);
            } catch (e) {
                log.warning('结算总结失败: ' + (e instanceof Error ? e.message : String(e)));
                ok = false;
            }
            if (!ok) {
                // 指数退避：5 → 15 → 60 分钟（失败次数在运行时，不持久化）
                const rt = runtimeOf(host);
                rt.settleFailCount = (rt.settleFailCount || 0) + 1;
                const backoffMin = rt.settleFailCount <= 1 ? 5 : rt.settleFailCount === 2 ? 15 : 60;
                s.settleBackoffUntil = now + backoffMin * 60 * 1000;
                log.warning(`结算失败，${backoffMin} 分钟后重试（已成功 ${done} 个分片）`);
                return done;
            }
            s.settledSeq = Math.max(typeof s.settledSeq === 'number' ? s.settledSeq : 0, shard.seq);
            done++;
        }
        if (done > 0) {
            runtimeOf(host).settleFailCount = 0;
            s.settleBackoffUntil = 0;
            try { s.save(true); } catch { /* 游离/桩会话无 save */ }
        }
        return done;
    }

    /**
     * L1 窗口移出（P1-2，docs/03 上下文/分片模块）：纯代码、零 LLM，让 `session_<id>` 的体积**有上界**。
     *
     * 与 L2（`archiveByTokenIfNeeded` 的 summarize 结算）解耦：这里只做"搬走原文"，
     * 不调用任何模型。窗口外的条目写进 `session_<id>:raw:<seq>` 分片（只写一次、幂等），
     * 然后从 messages 移除；`read_raw kind=user id=raw:<seq>` 仍可回查。
     *
     * 关键不变量：
     * - **绝不拆散工具原子组**（`assistant(tool_calls)` + 紧随的 `tool` 结果同进同留）；
     * - **写分片失败则不移除**（与归档同一原则：宁可留着重试，也不丢原文）；
     * - 「归档保留原文」关闭时不写分片，直接移除（省存储）。
     *
     * @returns 本次移出的条目数（0 表示未超上限或没得移）
     */
export function trimToWindow(host: ArchiveHost): number {
        const { ARCHIVE_KEEP_RAW } = Config.context;
        const s: any = host.session;
        if (!s || !s.sessionId) return 0;       // 游离/桩会话：无持久化身份，无处留档
        // 按会话覆盖优先（P2-1）
        const WINDOW_MAX_CHARS = s.setting?.overrideOr?.('windowMaxChars', Config.context.WINDOW_MAX_CHARS)
            ?? Config.context.WINDOW_MAX_CHARS;
        if (WINDOW_MAX_CHARS <= 0) return 0;   // 0=不移出（保持 P0 行为）

        const keep = pickWindowTail(host, WINDOW_MAX_CHARS);
        if (keep.startIndex <= 0) return 0;

        const moved = host.messages.slice(0, keep.startIndex);
        const rawItems = collectRawItems(moved);

        // 留档顺序：**先安全落分片，再从上下文移除**（与归档同一不变量）。
        // 关掉「归档保留原文」= 不留原文，此时跳过写分片、直接移除（省存储）。
        if (ARCHIVE_KEEP_RAW && rawItems.length > 0) {
            const nextSeq = (typeof s.rawSeq === 'number' ? s.rawSeq : 0) + 1;
            const outcome = writeShardIfAbsent(s.sessionId, nextSeq, {
                seq: nextSeq,
                from: rawItems[0].time,
                to: rawItems[rawItems.length - 1].time,
                items: rawItems,
            }, false, 'raw');
            // 写不进去就不移：宁可 session 继续变大，也不丢原文（与归档 B1 一致）
            if (outcome === 'failed') return 0;
            s.rawSeq = Math.max(typeof s.rawSeq === 'number' ? s.rawSeq : 0, nextSeq);
            s.lastRawAt = Math.floor(Date.now() / 1000);
            // 分片上限（可配）与惰性 TTL 淘汰：最旧/过期的置空（海豹无删除 API，置空即项目内先例做法）
            const { SHARD_LIMIT, SHARD_TTL_DAYS } = Config.context;
            // **必须清到"所有超出上限的"**，不能只清 `rawSeq - SHARD_LIMIT` 这一个：
            // 只清一个的话，一旦出现"多次写入但只触发部分 trim"（批量灌水、写入失败后重试、
            // 进程重启丢掉未落盘的 rawSeq 等），旧分片会永久滞留 —— 上限形同虚设。
            // 已由 sim-matrix 的 D3 用例暴露（上限设 3 时实际残留 101 个活跃分片）。
            if (SHARD_LIMIT > 0) {
                for (let seq = s.rawSeq - SHARD_LIMIT; seq >= 1; seq--) clearShard(s.sessionId, seq, 'raw');
            }
            evictExpiredShards(s.sessionId, 'raw', s.rawSeq, SHARD_TTL_DAYS, Math.floor(Date.now() / 1000));
        }

        // 移除窗口外条目（含 assistant/tool：它们已随窗口滚出，原文不值得留档）
        host.messages.splice(0, keep.startIndex);
        // **必须立即写**（不用 save(true)）：这里已经"破坏性移除"了消息，若延迟到 5 秒后写盘，
        // 期间进程被杀会留下"分片已写 + rawSeq 已推进（都只在内存）+ 上下文仍是旧内容"的错位，
        // 重载后这些消息**复活**，下次又写一份新分片 → 原文重复留档、体积重新越界。
        // 移出本身是低频事件（只在窗口真正溢出时发生），立即写的代价可接受。
        try { s.save(); } catch { /* 游离/桩会话无 save */ }
        return moved.length;
    }

    /**
     * 选出"要保留的窗口尾部"：从新到旧按**条目**粒度累加渲染字数，直到达到预算。
     * 返回 `startIndex`＝messages 中保留区间的起始下标（0 表示全部保留）。
     *
     * **工具配对是硬不变量，而不是"扫描顺序的技巧"**（本函数两次修 bug 的教训）：
     * 一条 `role:'tool'` 必须有发起它的 `assistant(tool_calls)`；反之带 toolCalls 的 assistant
     * 也必须有对应的 tool 结果。违反即请求 400。
     *
     * 因此分两步，与扫描顺序无关：
     *   ① 按预算从新到旧**粗选**一个 startIndex（纯长度累加，不关心角色）；
     *   ② **配对修复** `alignToToolPairing()`：把 startIndex 上移到"保留区间自洽"的位置。
     * 这样对连续 / 非连续 / 前导悬空 等各种形态都成立。
     */
function pickWindowTail(host: ArchiveHost, budgetChars: number): { startIndex: number } {
        let used = 0;
        let startIndex = host.messages.length;
        for (let i = host.messages.length - 1; i >= 0; i--) {
            const len = buildContent(host.messages[i] as any).length;
            if (used + len > budgetChars) break;
            used += len;
            startIndex = i;
        }
        // 配对修复可能上移 startIndex（窗口略超预算），但绝不产生非法请求
        return { startIndex: alignToToolPairing(host, startIndex) };
    }

    /**
     * 把保留区间起点上移到"工具配对自洽"的位置。
     * 自洽＝区间内没有孤儿 tool、也没有结果被切在区间外的半截 assistant(tool_calls)。
     *
     * 修正规则：
     * - 区间内有孤儿 tool：owner 在区间外 → 上移到 owner；连 owner 都找不到（数据异常）→ 把该 tool 本身排除。
     * - 区间内有结果缺失的 assistant(tool_calls)：保留"模型看不到工具返回"的半截调用没有意义，
     *   且它的 tool 随后会变成孤儿 → 把该 assistant 一起移出（上移到它之后）。
     *
     * 上移可能引入新的越界关系，故循环到稳定（实际 1~2 轮，上限 O(n) 兜底）。
     */
function alignToToolPairing(host: ArchiveHost, startIndex: number): number {
        let start = startIndex;
        for (let guard = 0; guard <= host.messages.length; guard++) {
            if (start >= host.messages.length) return host.messages.length;
            const resultIds = new Set<string>();
            for (let k = start; k < host.messages.length; k++) {
                const m = host.messages[k] as any;
                if (m?.role === 'tool' && m.tool_call_id) resultIds.add(String(m.tool_call_id));
            }
            let bump = -1;
            for (let k = start; k < host.messages.length; k++) {
                const m = host.messages[k] as any;
                if (!m) continue;
                if (m.role === 'tool') {
                    const rid = toolResultCallId(m);
                    const orphan = !rid || !hasCallIdBefore(host, rid, start, k);
                    if (orphan) {
                        const owner = findToolOwnerBefore(host, k, start);
                        bump = Math.max(bump, owner >= 0 ? owner : k + 1);
                    }
                } else if (m.role === 'assistant') {
                    const calls = m.toolCalls || m.tool_calls;
                    if (!Array.isArray(calls) || calls.length === 0) continue;
                    const missing = calls.some((tc: any) => tc && tc.id && !resultIds.has(String(tc.id)));
                    if (missing) bump = Math.max(bump, k + 1);
                }
            }
            if (bump < 0 || bump <= start) return start;
            start = bump;
        }
        return start;
    }

    /** 区间 `[from, to)` 内是否存在发起 `callId` 的 assistant(tool_calls) */
function hasCallIdBefore(host: ArchiveHost, callId: string, from: number, to: number): boolean {
        for (let k = from; k < to; k++) {
            const m = host.messages[k] as any;
            if (!m || m.role !== 'assistant') continue;
            const calls = m.toolCalls || m.tool_calls;
            if (!Array.isArray(calls)) continue;
            if (calls.some((tc: any) => tc && tc.id && String(tc.id) === String(callId))) return true;
        }
        return false;
    }

    /** 在 `[limit, toolIdx)` 内找发起 `messages[toolIdx]` 的 assistant（按 tool_call_id 精确匹配） */
function findToolOwnerBefore(host: ArchiveHost, toolIdx: number, limit = 0): number {
        const wantId = toolResultCallId(host.messages[toolIdx]);
        for (let k = toolIdx - 1; k >= limit; k--) {
            const m = host.messages[k] as any;
            if (!m || m.role !== 'assistant') continue;
            const calls = m.toolCalls || m.tool_calls;
            if (!Array.isArray(calls) || calls.length === 0) continue;
            if (!wantId || calls.some((tc: any) => tc && tc.id === wantId)) return k;
        }
        return -1;
    }

    /** 从一批消息里抽取可留档的群聊原文（复用归档分片的条目口径） */
function collectRawItems(chunk: MessageType[]): ArchiveShardItem[] {
        const items: ArchiveShardItem[] = [];
        for (const m of chunk) {
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            for (const raw of (m as UserMessage).contentItems as UserMessageItem[]) {
                if (!raw || typeof raw.text !== 'string' || !raw.userId) continue;   // 系统条目不入分片
                if (Array.isArray(raw.rawItems) && raw.rawItems.length > 0) {
                    for (const ri of raw.rawItems) {
                        if (!ri || !ri.userId) continue;
                        items.push({ messageId: ri.messageId || '', userId: ri.userId, time: ri.time || 0, text: ri.text });
                    }
                    continue;
                }
                items.push({
                    messageId: raw.messageId || '',
                    userId: raw.userId,
                    time: raw.time || 0,
                    text: stripRawMarkers(raw.rawText ?? raw.text),
                });
            }
        }
        return items;
    }

    /**
     * 基于 token 上限执行归档（观察归档 + 分片留档 + 移除条目）：
     * - targetTokens 缺省时用「上下文最大token」配置；
     * - 超过上限时保留最近 MAX_ROUNDS 个真实 user 轮，更早消息分块归档（summarize 沉淀记忆）；
     * - 归档的群聊原文写进独立分片 key（**只写一次、永不重写**），再从上下文移除；
     * - 轮数不够时（待机群常见：只有 1 轮）按"条"归档，**不再整段硬删**（修 M7）。
     * @returns 'converged' 已收敛到上限内 / 'busy' 已有归档在飞（本次未做事，调用方可稍后重试）/
     *          'failed' 归档失败（数据保持原样，不再做降级硬删）
     */
export async function archiveByTokenIfNeeded(host: ArchiveHost, targetTokens?: number): Promise<'converged' | 'busy' | 'failed'> {
        if (archivingHosts.has(host)) return 'busy';
        archivingHosts.add(host);

        try {
            const { MAX_ROUNDS, MAX_CONTEXT_TOKENS } = Config.context;
            // 未传 target 时回退配置上限；配置为 0（P2-3：跟随探测窗口）时解析为有效预算。
            // 解析仍拿不到（未探测过）时回退默认值——**不再当作"不限制"**，否则归档永远不触发。
            const target = targetTokens && targetTokens > 0
                ? targetTokens
                : resolveEffectiveMaxTokens(MAX_CONTEXT_TOKENS, getProbedContextWindow(Model.getChatModel('chat')?.name || '')).tokens;
            const keepRounds = MAX_ROUNDS > 0 ? MAX_ROUNDS : 5;
            let converged = true;

            while (estimateContextMessagesTokens(host.messages) > target) {
                const keepStart = getKeepStart(host.messages, keepRounds);
                const toArchive = host.messages.slice(0, keepStart);

                if (toArchive.length > 0) {
                    if (await archivePrefix(host, toArchive)) continue;
                } else if (await archiveOldestItems(host)) {
                    continue;
                }
                // 归档失败：不删数据、不做硬删兜底，如实返回"未收敛"（调用方据此提示/重试）
                converged = false;
                break;
            }

            const rt = runtimeOf(host);
            if (converged) {
                rt.archiveFailCount = 0;
                return 'converged';
            }
            // 连续失败兜底：summarize 长期不可用（或超长内容集中在 assistant/tool、无 user 条目可归档）时，
            // 若一直只返回 failed，会话会永久无法回复。连续失败到阈值后允许一次"降级丢弃最早轮次"（不写记忆），
            // 让会话恢复可用——这是旧 forceFit 行为的受限版，且日志可见。
            rt.archiveFailCount++;
            if (rt.archiveFailCount < ARCHIVE_FAIL_LIMIT) return 'failed';
            rt.archiveFailCount = 0;
            await forceFitAsLastResort(host, target);
            return estimateContextMessagesTokens(host.messages) <= target ? 'converged' : 'failed';
        } finally {
            archivingHosts.delete(host);
        }
    }

    /** 归档连续失败后的最后手段：丢弃最早的轮次（不含 summarize），只保证会话还能回复 */
async function forceFitAsLastResort(host: ArchiveHost, targetTokens: number): Promise<void> {
        let safety = 0;
        while (estimateContextMessagesTokens(host.messages) > targetTokens && host.messages.length > 0 && safety < 10000) {
            if (!dropOldestRound(host.messages)) break;
            safety++;
        }
        log.warning(`[ctx-cost] 归档连续失败 ${ARCHIVE_FAIL_LIMIT} 次，已降级丢弃最早轮次（不写记忆），剩余 token=${estimateContextMessagesTokens(host.messages)}`);
    }

async function archivePrefix(host: ArchiveHost, toArchive: MessageType[]): Promise<boolean> {
        const chunks = splitMessagesByToken(toArchive, ARCHIVE_CHUNK_TOKENS);
        // 「归档保留原文」关闭时：**仍然 summarize 沉淀记忆，只是不写归档分片**（不留原文，省存储）。
        // 语义区分：开关只控制"原文档留"，不控制"记忆沉淀"——否则关掉开关会让历史既不进记忆也查不到，等于白丢。
        const keepRaw = Config.context.ARCHIVE_KEEP_RAW;

        for (const chunk of chunks) {
            const ok = await MemoryManager.summarizeChunkWithRetry(host.session, chunk);
            if (!ok) return false;
            if (keepRaw) {
                // 原文必须先安全落进归档分片（幂等），才允许从上下文移除
                if (writeArchiveShard(host, chunk) === 'failed') return false;
            }
            // chunk 始终是当前消息数组最前的一段（前面的块成功后已移除）
            host.messages.splice(0, chunk.length);
            try { host.session.save(); } catch { /* 无宿主会话时跳过保存（测试/游离 Context） */ }
        }

        return true;
    }

    /**
     * 轮数不够时的兜底归档：按 contentItem 粒度取出最旧一段（受 ARCHIVE_CHUNK_TOKENS 限制），
     * 先 summarize 沉淀记忆，再写归档分片并移除条目。**不做整段硬删**（修 M7）。
     */
async function archiveOldestItems(host: ArchiveHost): Promise<boolean> {
        const picked: MessageType[] = [];
        let tokens = 0;
        for (const m of host.messages) {
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            const taken: UserMessageItem[] = [];
            for (const it of (m as UserMessage).contentItems as UserMessageItem[]) {
                const t = estimateMessageTokens({ role: 'user', contentItems: [it] } as any);
                if (tokens > 0 && tokens + t > ARCHIVE_CHUNK_TOKENS) break;
                taken.push(it);
                tokens += t;
            }
            if (taken.length === 0) continue;
            picked.push({ role: 'user', contentItems: taken } as UserMessage);
            if (tokens >= ARCHIVE_CHUNK_TOKENS) break;
        }
        if (picked.length === 0) return false;

        // 「归档保留原文」关闭时：**仍然 summarize 沉淀记忆，只是不写归档分片**（不留原文，省存储）
        const ok = await MemoryManager.summarizeChunkWithRetry(host.session, picked);
        if (!ok) return false;
        if (Config.context.ARCHIVE_KEEP_RAW) {
            if (writeArchiveShard(host, picked) === 'failed') return false;   // 未留档成功则不移除
        }
        removeArchivedItems(host, picked);
        try { host.session.save(); } catch { /* 游离 Context */ }
        return true;
    }

    /**
     * 把这批消息里的 user 条目原文写进归档分片（幂等：分片已存在则跳过），并推进 archiveSeq。
     * @returns 'stored' 已安全留档（可移除来源）/ 'nothing' 没有可留档的群聊原文（移除是安全的）/ 'failed' 写入失败（**不得移除来源**）
     */
function writeArchiveShard(host: ArchiveHost, chunk: MessageType[]): 'stored' | 'nothing' | 'failed' {
        const s: any = host.session;
        // 游离/桩会话（无 archiveSeq 或无语会 id）没有持久化身份，无处留档——此时移除是安全的
        if (!s || typeof s.archiveSeq !== 'number' || !s.sessionId) return 'nothing';
        const items: ArchiveShardItem[] = [];
        for (const m of chunk) {
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            for (const raw of (m as UserMessage).contentItems as UserMessageItem[]) {
                if (!raw || typeof raw.text !== 'string' || !raw.userId) continue;   // 系统条目（事件/提示）不入分片
                if (Array.isArray(raw.rawItems) && raw.rawItems.length > 0) {
                    // 压缩块：块内逐条原文才是真原文
                    for (const ri of raw.rawItems) {
                        if (!ri || !ri.userId) continue;
                        items.push({ messageId: ri.messageId || '', userId: ri.userId, time: ri.time || 0, text: ri.text });
                    }
                    continue;
                }
                items.push({
                    messageId: raw.messageId || '',
                    userId: raw.userId,
                    time: raw.time || 0,
                    text: stripRawMarkers(raw.rawText ?? raw.text),
                });
            }
        }
        if (items.length === 0) return 'nothing';   // 这批里没有群聊原文，无需留档即可移除
        const seq = s.archiveSeq + 1;
        // B1：存在性由持久化水位（archiveSeq）判定，**不靠读分片本体**——storageGet 对不存在的 key
        // 也抛异常，"不存在"与"读失败"不可区分，读异常不能当作存在性结论（详见 archive_store.ts）。
        const knownExists = seq <= s.archiveSeq;
        const outcome = writeShardIfAbsent(s.sessionId, seq, {
            seq,
            from: items[0].time,
            to: items[items.length - 1].time,
            items,
        }, knownExists);
        if (outcome === 'failed') return 'failed';
        // 'exists' 也必须把序号推进到该 seq：否则一旦出现"分片已写、archiveSeq 未落盘"的错位
        // （崩溃/存档写失败），后续每批都会撞上同一个 seq（永远 exists）→ 原文再也不会写进分片。
        s.archiveSeq = Math.max(s.archiveSeq, seq);
        s.lastArchivedAt = Math.floor(Date.now() / 1000);
        // 分片数量上限（可配）：最旧的置空（海豹没有 delete API，置空即项目内先例做法）
        // 同 raw 分支：必须清到"所有超出上限的"，只清一个会在跳号/重试时让旧分片永久滞留。
        const { SHARD_LIMIT } = Config.context;
        if (SHARD_LIMIT > 0) {
            for (let old = s.archiveSeq - SHARD_LIMIT; old >= 1; old--) clearShard(s.sessionId, old, 'arc');
        }
        return 'stored';
    }

    /** 从 messages 中移除已归档的条目（按条目对象定位，保持其余内容与顺序不变） */
function removeArchivedItems(host: ArchiveHost, archived: MessageType[]): void {
        const marked = new Set<any>();
        for (const m of archived) {
            if (Message.getMessageType(m) !== 'user') continue;
            for (const it of (m as UserMessage).contentItems || []) marked.add(it);
        }
        for (let i = host.messages.length - 1; i >= 0; i--) {
            const m = host.messages[i];
            if (Message.getMessageType(m) !== 'user' || !Array.isArray((m as UserMessage).contentItems)) continue;
            const um = m as UserMessage;
            um.contentItems = um.contentItems.filter(it => !marked.has(it));
            if (um.contentItems.length === 0) host.messages.splice(i, 1);
        }
    }

