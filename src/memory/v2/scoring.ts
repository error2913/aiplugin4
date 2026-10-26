// 记忆打分/召回策略（纯函数）：RRF、关键词、图扩散、时序窗口、淘汰排序、文本工具。
import type { MemoryUnit, TagsMatch } from "./types";

function charNGrams(text: string): Set<string> {
    const v = String(text || "").toLowerCase().replace(/\s+/g, "");
    const out = new Set<string>();
    for (let i = 0; i < v.length - 1; i++) out.add(v.slice(i, i + 2));
    return out;
}

export function filterByTags(units: MemoryUnit[], tags: string[], match: TagsMatch = 'any'): MemoryUnit[] {
    if (!tags.length) return units;
    return units.filter(u => {
        if (match === 'exact') return tags.length === u.tags.length && tags.every(t => u.tags.includes(t));
        if (match === 'all' || match === 'all_strict') {
            if (match === 'all_strict' && u.tags.length === 0) return false;
            return tags.every(t => u.tags.includes(t));
        }
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
    const grams = charNGrams(query);
    let score = 0;
    if (tokens.length) {
        const lower = text.toLowerCase();
        score += tokens.filter(t => lower.includes(t.toLowerCase())).length / tokens.length;
    }
    if (grams.size) {
        const textGrams = charNGrams(text);
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
    return units
        .filter(u => {
            const start = u.occurredStart ?? u.mentionedAt ?? u.createdAt ?? 0;
            const end = u.occurredEnd ?? u.occurredStart ?? u.mentionedAt ?? start;
            return end >= window.start && start <= window.end;
        })
        .map(u => u.id);
}

export function rrf(lists: Array<{ strategy: string; ids: string[] }>): Array<[string, number]> {
    const scores = new Map<string, number>();
    for (const list of lists) {
        list.ids.forEach((id, idx) => {
            const rank = idx + 1;
            scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank));
        });
    }
    return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
}

export function matchedStrategies(lists: Array<{ strategy: string; ids: string[] }>, id: string): string[] {
    return lists.filter(l => l.ids.includes(id)).map(l => l.strategy);
}

/** 淘汰分组（越小越先删）：0=无效/已被观察覆盖；1=普通；2=观察派生；3=保护。 */
export function evictionGroup(u: MemoryUnit, coveredIds: Set<string>): number {
    if (u.importance >= PROTECT_IMPORTANCE || u.metadata?.pinned === '1' || u.tags.includes('pinned')) return 3;
    if (u.state === 'invalidated') return 0;
    if (u.consolidationState === 'done' && coveredIds.has(u.id)) return 1;
    return 2;
}

export function decayScore(u: MemoryUnit, nowSec: number): number {
    const last = u.lastAccessedAt || u.updatedAt || u.createdAt || nowSec;
    const ageDays = Math.max(0, (nowSec - last) / 86400);
    return u.importance * Math.exp((-Math.LN2 * ageDays) / DECAY_HALF_LIFE_DAYS);
}

export function sameCluster(a: MemoryUnit, b: MemoryUnit): boolean {
    if (a.entityIds.some(id => b.entityIds.includes(id))) return true;
    return textSimilarity(a.text, b.text) >= 0.6;
}

export function tokenize(s: string): string[] {
    return Array.from(new Set(String(s || '').toLowerCase().split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(t => t.length > 0)));
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
    const ga = charNGrams(a || '');
    const gb = charNGrams(b || '');
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
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.35;
export const SEMANTIC_LINK_MIN = 0.7;
export const DEDUP_THRESHOLD = 0.97;
export const PROTECT_IMPORTANCE = 0.9;
export const DECAY_HALF_LIFE_DAYS = 60;
export const OBSERVATION_STALE_DAYS = 90;
