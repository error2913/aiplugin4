// Context v2 管理操作：物理清除 / 逻辑遗忘 / 状态统计 / head 修复。
// 海豹 storage 无删除 API：purge 用置空字符串表达"清除"，并把 head 推进到新 epoch，
// 旧 seq/pageNo 不复用（INV-D），新会话从空白开始。
import { getHost } from "../core/host";

import type { ContextHead } from "./head";
import { normalizeHead, parseHead, serializeHead } from "./head";
import { eventPageKey, headKey, legacyShardKey, recordPageKey } from "./keys";
import { ContextStore } from "./store";

export type HideTarget = 'user' | 'assistant' | 'all';

export interface PurgeResult {
    clearedEventPages: number;
    clearedRecordPages: number;
    clearedLegacyShards: number;
    head: ContextHead;
}

export interface ContextStats {
    events: number;
    records: number;
    pages: number;
    recordPages: number;
    bytesTotal: number;
    epoch: number;
    firstSeq: number;
    lastSeq: number;
    summarizedThrough: number;
    unsummarizedTokens: number;
    legacy: boolean;
}

/** 清空一个 key（置空字符串）；已为空/不存在也视为成功 */
function clearKey(key: string): void {
    try {
        getHost().storage.set(key, '');
    } catch {
        // 单 key 失败不阻断整体 purge；head 仍会推进，旧数据不可达
    }
}

/**
 * 全清除：枚举 head 记录的页范围并置空，legacy 分片也清；
 * 最后写新 head（epoch+1，pageFloor/recFloor 前移，summarizedThrough 归零）。
 * 注意：默认不动长期记忆；记忆由记忆系统自己的清理路径处理。
 */
export function purgeSession(sessionId: string, head: ContextHead): PurgeResult {
    const nextHead: ContextHead = {
        ...head,
        epoch: head.epoch + 1,
        epochStartSeq: head.nextSeq,
        nextSeq: head.nextSeq,
        persistedSeq: head.nextSeq - 1,
        pageFloor: head.nextPageNo,
        recFloor: head.nextRecPageNo,
        summarizedThrough: head.epochStartSeq - 1 + (head.nextSeq - head.epochStartSeq),
        unsummarizedTokens: 0,
        bytesTotal: 0,
        legacy: head.legacy
            ? { ...head.legacy, phase: 'flipped' }
            : undefined,
    };
    nextHead.summarizedThrough = nextHead.epochStartSeq - 1;

    let clearedEventPages = 0;
    for (let pageNo = head.pageFloor; pageNo < head.nextPageNo; pageNo++) {
        clearKey(eventPageKey(sessionId, pageNo));
        clearedEventPages++;
    }
    let clearedRecordPages = 0;
    for (let pageNo = head.recFloor; pageNo < head.nextRecPageNo; pageNo++) {
        clearKey(recordPageKey(sessionId, pageNo));
        clearedRecordPages++;
    }
    let clearedLegacyShards = 0;
    if (head.legacy) {
        for (let seq = 1; seq <= Math.max(head.legacy.archiveSeq, head.legacy.rawSeq); seq++) {
            if (seq <= head.legacy.archiveSeq) {
                clearKey(legacyShardKey(sessionId, 'arc', seq));
                clearedLegacyShards++;
            }
            if (seq <= head.legacy.rawSeq) {
                clearKey(legacyShardKey(sessionId, 'raw', seq));
                clearedLegacyShards++;
            }
        }
        nextHead.legacy = {
            archiveSeq: 0,
            rawSeq: 0,
            settledSeq: 0,
            phase: 'flipped',
        };
    }

    getHost().storage.set(headKey(sessionId), serializeHead(nextHead));
    return { clearedEventPages, clearedRecordPages, clearedLegacyShards, head: nextHead };
}

/** 逻辑遗忘：只追加 RedactRecord；原文保留，审计可查 */
export function hideEvents(store: ContextStore, target: HideTarget, now = Math.floor(Date.now() / 1000)): void {
    const head = store.getHead();
    store.appendRecord({
        kind: 'redact',
        id: `redact:${head.epoch}:${head.nextSeq}:${now}`,
        at: now,
        epoch: head.epoch,
        fromSeq: head.epochStartSeq,
        toSeq: Math.max(head.epochStartSeq, head.nextSeq - 1),
        target,
    });
}

/** 状态统计（`.ai ctx` 短输出用） */
export function contextStats(store: ContextStore): ContextStats {
    const snapshot = store.snapshot();
    const head = store.getHead();
    const seqs = snapshot.events.map(e => e.seq);
    return {
        events: snapshot.events.length,
        records: snapshot.records.length,
        pages: Math.max(0, head.nextPageNo - head.pageFloor),
        recordPages: Math.max(0, head.nextRecPageNo - head.recFloor),
        bytesTotal: head.bytesTotal,
        epoch: head.epoch,
        firstSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
        lastSeq: seqs.length > 0 ? Math.max(...seqs) : 0,
        summarizedThrough: head.summarizedThrough,
        unsummarizedTokens: head.unsummarizedTokens,
        legacy: !!head.legacy,
    };
}

/** 读取并修复 head（损坏时返回 null，由上层提示/重建） */
export function repairHead(sessionId: string): ContextHead | null {
    let raw: string | null = null;
    try {
        raw = getHost().storage.get(headKey(sessionId));
    } catch {
        return null;
    }
    if (!raw) return null;
    const normalized = normalizeHead(parseJson(raw));
    if (!normalized) return null;
    if (serializeHead(normalized) !== serializeHead(parseHead(raw) ?? normalized)) {
        getHost().storage.set(headKey(sessionId), serializeHead(normalized));
    }
    return normalized;
}

function parseJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
