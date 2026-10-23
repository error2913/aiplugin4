// 记忆打分/召回策略（叶子，纯函数）：RRF 融合、关键词与图检索打分、时序窗口、淘汰排序与衰减、文本工具。
// 从 memory/v2/engine.ts 拆出——打分策略只依赖 MemoryUnit 与工具函数，便于单测与替换；
// engine.ts 保留 import 调用，行为与改造前一致。
import { buildCharNGrams } from "../../utils/string";

import type { MemoryUnit } from "./types";

export function filterByTags(units: MemoryUnit[], tags: string[], match: 'any' | 'all' | 'exact'): MemoryUnit[] {
    if (!tags.length) return units;
    return units.filter(u => {
        if (match === 'exact') {
            return tags.length === u.tags.length && tags.every(t => u.tags.includes(t));
        }
        if (match === 'all') return tags.every(t => u.tags.includes(t));
        return tags.some(t => u.tags.includes(t));
    });
}

export function semanticLimit(budget: string): number {
    return budget === 'high' ? 100 : budget === 'low' ? 20 : 50;
}

export function keywordLimit(budget: string): number {
    return budget === 'high' ? 100 : budget === 'low' ? 20 : 50;
}

export function keywordScore(text: string, query: string): number {
    if (!query) return 0;
    const tokens = tokenize(query);
    const grams = buildCharNGrams(query);
    let score = 0;
    if (tokens.length) {
        score += tokens.filter(t => text.includes(t)).length / tokens.length;
    }
    if (grams.size) {
        const textGrams = buildCharNGrams(text);
        if (textGrams.size) {
            let hit = 0;
            for (const g of grams) if (textGrams.has(g)) hit++;
            score += hit / grams.size;
        }
    }
    return score;
}

export function temporalSearch(units: MemoryUnit[], query: string): string[] {
    const window = parseTemporalWindow(query);
    if (!window) return [];
    const inWindow = units.filter(u => {
        const start = u.occurredStart ?? u.mentionedAt ?? 0;
        const end = u.occurredEnd ?? u.occurredStart ?? u.mentionedAt ?? start;
        return end >= window.start && start <= window.end;
    });
    return inWindow.map(u => u.id);
}

export function rrf(lists: Array<{ strategy: string; ids: string[] }>): Array<[string, number]> {
    const scores = new Map<string, number>();
    for (const list of lists) {
        list.ids.forEach((id, idx) => {
            const rank = idx + 1;
            scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank));
        });
    }
    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1]);
}

export function matchedStrategies(lists: Array<{ strategy: string; ids: string[] }>, id: string): string[] {
    return lists.filter(l => l.ids.includes(id)).map(l => l.strategy);
}

/** 淘汰分组（越小越先删）：0=已被观察覆盖 1=普通单元 2=observation 沉淀 3=保护项（最后删，但上限硬约束下仍删） */
export function evictionGroup(u: MemoryUnit, coveredIds: Set<string>): number {
    if (u.importance >= PROTECT_IMPORTANCE || u.metadata?.pinned === '1' || u.tags.includes('pinned')) return 3;
    if (u.factType === 'observation') return 2;
    if (u.consolidationState === 'done' && coveredIds.has(u.id)) return 0;
    return 1;
}

/** 衰减分：importance × 2^(−未访问天数/半衰期)，越低越先淘汰 */
export function decayScore(u: MemoryUnit, nowSec: number): number {
    const last = u.lastAccessedAt || u.updatedAt || u.createdAt || nowSec;
    const ageDays = Math.max(0, (nowSec - last) / 86400);
    return u.importance * Math.exp((-Math.LN2 * ageDays) / DECAY_HALF_LIFE_DAYS);
}

export function sameCluster(a: MemoryUnit, b: MemoryUnit): boolean {
    const sharedEntities = a.entityIds.some(id => b.entityIds.includes(id));
    if (sharedEntities) return true;
    const sharedTags = a.tags.some(t => b.tags.includes(t) && (t.startsWith('user:') || t.startsWith('group:')));
    if (sharedTags) return true;
    return textSimilarity(a.text, b.text) >= 0.6;
}

export function tokenize(s: string): string[] {
return Array.from(new Set(String(s || '').split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(t => t.length > 0)));
}

export function simpleHash(s: string): string {
let h = 0;
for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
}
return String(h);
}

export function estimateTokens(text: string): number {
let cjk = 0;
let other = 0;
for (const ch of String(text || '')) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
    else if (ch.trim()) other++;
}
return cjk + Math.ceil(other / 4);
}

export function textSimilarity(a: string, b: string): number {
const ga = buildCharNGrams(a || '');
const gb = buildCharNGrams(b || '');
if (!ga.size || !gb.size) return 0;
let hit = 0;
for (const g of ga) if (gb.has(g)) hit++;
return hit / Math.min(ga.size, gb.size);
}

export function parseTemporalWindow(query: string): { start: number; end: number } | null {
const now = new Date();
const year = now.getFullYear();
const month = now.getMonth();
const day = now.getDate();
const startOfDay = new Date(year, month, day).getTime();
if (/今年|本年/.test(query)) return { start: new Date(year, 0, 1).getTime(), end: now.getTime() };
if (/去年/.test(query)) return { start: new Date(year - 1, 0, 1).getTime(), end: new Date(year - 1, 11, 31, 23, 59, 59).getTime() };
if (/上个月|上月/.test(query)) return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime() - 1 };
if (/这个月|本月/.test(query)) return { start: new Date(year, month, 1).getTime(), end: now.getTime() };
if (/今天|今日/.test(query)) return { start: startOfDay, end: now.getTime() };
if (/昨天/.test(query)) return { start: startOfDay - 86400000, end: startOfDay - 1 };
if (/前天/.test(query)) return { start: startOfDay - 2 * 86400000, end: startOfDay - 86400000 - 1 };
const m = query.match(/(\d{4})年(\d{1,2})月/);
if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return { start: new Date(y, mo - 1, 1).getTime(), end: new Date(y, mo, 1).getTime() - 1 };
}
return null;
}

export const RRF_K = 60;

export const SEMANTIC_SIMILARITY_THRESHOLD = 0.8;

/** 遗忘保护：importance 达到该值（或 pinned）的记忆最后淘汰（上限仍是硬约束，超限仍会删） */
export const PROTECT_IMPORTANCE = 0.9;

/** 衰减分半衰期（天）：decayScore = importance × 2^(−未访问天数/半衰期)，用于超限时排序 */
export const DECAY_HALF_LIFE_DAYS = 60;
