// 用量限制窗口：窗口键、边界、峰时片段解析与命中判定（L2 能力层）。
//
// 设计要点（.dev/issue-59-requirements.md §6.2/§6.4）：
// - 窗口**固定边界、惰性重置**：不启定时器，读计数时比对键，键不同就视为 0；
// - 5 小时窗口按本地时区切 00/05/10/15/20 五段，最后一段只有 4 小时；
// - 周窗口以**周一**为起点；月窗口按自然月；
// - 峰时片段是「周几 + 时段 + 百分比」，百分比是**预算系数**（乘在总限制上），不是消费折扣。
import { logger } from '../logger';
import { type ActiveTimeSegment, isInSegment, parseTimeRange, segmentsOverlap } from '../utils/time_window';

import type { PeakRule, PeakSegment, WindowKey } from './types';

/** 5 小时窗口的分段长度（分钟） */
const HOUR_SLOT_MINUTES = 300;

/** 一天的分钟数 */
export const MINUTES_PER_DAY = 24 * 60;

/** ISO 星期几：1=周一 … 7=周日（`Date#getDay()` 的 0=周日映射到 7） */
export function isoDayOf(now: number): number {
    const day = new Date(now).getDay();
    return day === 0 ? 7 : day;
}

/** 当日分钟数 0..1439 */
export function minuteOfDayOf(now: number): number {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
}

function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n);
}

/** 本地日期串 `YYYY-MM-DD` */
function dateKeyOf(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 窗口键（同一窗口内不变，键变即等价于计数归零）：
 * - `h`：`YYYY-MM-DD:<slot>`，slot = 0..4（00:00 / 05:00 / 10:00 / 15:00 / 20:00 起）
 * - `w`：本周周一的 `YYYY-MM-DD`
 * - `m`：`YYYY-MM`
 */
export function windowKeyOf(window: WindowKey, now: number): string {
    const d = new Date(now);
    if (window === 'h') {
        const slot = Math.floor(minuteOfDayOf(now) / HOUR_SLOT_MINUTES);
        return `${dateKeyOf(now)}:${slot}`;
    }
    if (window === 'm') return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - (isoDayOf(now) - 1));
    return `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
}

/** 窗口的起止毫秒（`end` 开区间，即下一窗口起点） */
export function windowBoundsOf(window: WindowKey, now: number): { start: number; end: number } {
    const d = new Date(now);
    if (window === 'h') {
        const slot = Math.floor(minuteOfDayOf(now) / HOUR_SLOT_MINUTES);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        start.setMinutes(slot * HOUR_SLOT_MINUTES);
        // 次日 00:00 是硬边界：末段（20:00 起）只有 4 小时，不能算到 25:00
        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
        const end = Math.min(start.getTime() + HOUR_SLOT_MINUTES * 60 * 1000, midnight.getTime());
        return { start: start.getTime(), end };
    }
    if (window === 'm') {
        const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
        return { start: start.getTime(), end: end.getTime() };
    }
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    start.setDate(start.getDate() - (isoDayOf(now) - 1));
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 7);
    return { start: start.getTime(), end: end.getTime() };
}

/** 下次重置时刻（= 窗口结束），命令展示用 */
export function nextResetAt(window: WindowKey, now: number): number {
    return windowBoundsOf(window, now).end;
}

/** 右侧锚定的时段部分：`HH:mm-HH:mm-百分比`（一次解析两时间 + 百分比，避免与 `1-5` 混淆） */
const PEAK_TAIL = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})-(\d{1,3})$/;

/** 周几部分：`dayItem (',' dayItem)*`，dayItem = `day` 或 `day-day` */
const PEAK_DAYS = /^\d(?:-\d)?$/;

function expandDays(text: string): { days: number[]; error?: string } {
    const days: number[] = [];
    const seen = new Set<number>();
    for (const item of text.split(',')) {
        const part = item.trim();
        if (!PEAK_DAYS.test(part)) return { days: [], error: '周几格式错误（1=周一…7=周日，支持 1-5、1,3,5、1-5,7）' };
        const pieces = part.split('-');
        const start = Number(pieces[0]);
        const end = pieces.length === 2 ? Number(pieces[1]) : start;
        if (start < 1 || start > 7 || end < 1 || end > 7) {
            return { days: [], error: '周几格式错误（1=周一…7=周日，支持 1-5、1,3,5、1-5,7）' };
        }
        if (start > end) return { days: [], error: '周几区间需从小到大（如 1-5）' };
        for (let day = start; day <= end; day++) {
            if (seen.has(day)) continue;
            seen.add(day);
            days.push(day);
        }
    }
    return { days };
}

/** 下一 ISO 星期几（7 → 1） */
function nextIsoDay(day: number): number {
    return day >= 7 ? 1 : day + 1;
}

/**
 * 把「周几 + 时段 + 百分比」展开成已跨 0 点拍平的片段列表。
 *
 * 跨 0 点语义（E-08）：`1-5 22:00-02:00` 归属**起始日**，即周一 22:00-24:00 与周二 00:00-02:00
 * 都算「周一那一档」。因此周一 01:00 不命中、周六 01:00 命中（周五段延伸到周六凌晨）。
 */
export function expandPeakSegments(
    days: readonly number[],
    start: number,
    end: number,
    pct: number,
    frame: number,
    raw: string,
): PeakSegment[] {
    const out: PeakSegment[] = [];
    for (const day of days) {
        if (start < end) {
            out.push({ day, start, end, pct, frame, raw });
        } else {
            out.push({ day, start, end: MINUTES_PER_DAY, pct, frame, raw });
            out.push({ day: nextIsoDay(day), start: 0, end, pct, frame, raw });
        }
    }
    return out;
}

/** 解析后的重叠判定：只比同一 ISO 星期几，且**边界相接不算重叠** */
function peakOverlap(a: PeakSegment, b: PeakSegment): boolean {
    if (a.day !== b.day) return false;
    // 复用活跃时间模块的重叠算法（边界相接不算重叠），保持两处语义一致
    return segmentsOverlap(
        { start: a.start, end: a.end, segs: 1 },
        { start: b.start, end: b.end, segs: 1 },
    );
}

/**
 * 解析「限制时段及百分比」模板。
 *
 * 文法：`[周几 ][HH:mm-HH:mm-百分比]`；周几支持 `1`、`1-5`、`1,3,5`、`1-5,7`。
 * 空模板 = 不收紧（返回空 segments），**绝不回退默认值**——用户清空是明确的「关掉峰谷」意图。
 */
export function parsePeakTemplate(texts: readonly string[] | undefined): PeakRule {
    const segments: PeakSegment[] = [];
    const warnings: string[] = [];
    const list = texts || [];
    for (let index = 0; index < list.length; index++) {
        const frame = index + 1;
        const raw = String(list[index] ?? '');
        const text = raw.trim();
        // 空框跳过：模板默认可能给 ['']，视为「未配置」
        if (!text) continue;
        const prefix = `「限制时段及百分比」第 ${frame} 框：`;
        const malformed = `${prefix}限制时段格式错误（应为 [周几 ]HH:mm-HH:mm-百分比，如 1-5 09:00-12:00-30）：${raw}`;

        // 以**第一个空白序列**切分：只允许一次分隔（`09:00 - 12:00` 报格式错误）
        const separator = /\s+/.exec(text);
        let head = '';
        let tail = text;
        if (separator) {
            head = text.slice(0, separator.index).trim();
            tail = text.slice(separator.index + separator[0].length).trim();
            if (/\s/.test(tail) || !head) {
                warnings.push(malformed);
                continue;
            }
        }

        // 周几：缺省 = 每天
        let days: number[] = [1, 2, 3, 4, 5, 6, 7];
        if (head) {
            const expanded = expandDays(head);
            if (expanded.error) {
                warnings.push(`${prefix}${expanded.error}：${raw}`);
                continue;
            }
            days = expanded.days;
        }

        // 时段 + 百分比：右锚定一次解析（两个时间与百分比由锚定唯一确定）
        const m = PEAK_TAIL.exec(tail);
        if (!m) {
            warnings.push(malformed);
            continue;
        }
        const parsed = parseTimeRange(`${m[1]}:${m[2]}-${m[3]}:${m[4]}`);
        if (parsed.error || !parsed.range) {
            warnings.push(`${prefix}时间范围错误（应为 HH:mm-HH:mm，开始≠结束）：${raw}`);
            continue;
        }
        const pct = Number(m[5]);
        if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
            warnings.push(`${prefix}百分比必须是 1~100 的整数：${raw}`);
            continue;
        }

        const expanded = expandPeakSegments(days, parsed.range.start, parsed.range.end, pct, frame, raw.trim());
        const kept: PeakSegment[] = [];
        for (const segment of expanded) {
            const overlapped = segments.some(existing => peakOverlap(existing, segment))
                || kept.some(existing => peakOverlap(existing, segment));
            if (overlapped) {
                warnings.push(`${prefix}限制时段重叠，已忽略后者：${raw.trim()}`);
                continue;
            }
            kept.push(segment);
        }
        segments.push(...kept);
    }
    return { segments, warnings };
}

/** 当前时刻命中的峰时片段（先到先得：segments 已按配置顺序）；未命中返回 null */
export function peakPercentAt(rule: PeakRule, now: number): { pct: number; segment: PeakSegment | null } {
    if (!rule.segments.length) return { pct: 100, segment: null };
    const day = isoDayOf(now);
    const minute = minuteOfDayOf(now);
    for (const segment of rule.segments) {
        if (segment.day !== day) continue;
        // 展开后 end 恒 > start，可直接用半开区间判定
        const probe: ActiveTimeSegment = { start: segment.start, end: segment.end, segs: 1 };
        if (isInSegment(probe, minute)) return { pct: segment.pct, segment };
    }
    return { pct: 100, segment: null };
}

/** 供单测/诊断：把规则打印成人读串 */
export function describePeakRule(rule: PeakRule): string {
    if (!rule.segments.length) return '(空)';
    return rule.segments.map(s => `周${s.day} ${s.start}-${s.end} ${s.pct}%`).join('; ');
}

/** 与 `segmentsOverlap` 同源的重叠工具（保留导出便于单测对齐既有活跃时间语义） */
export function peakSegmentsOverlap(a: PeakSegment, b: PeakSegment): boolean {
    return peakOverlap(a, b);
}

/** 告警出口：解析失败不是致命错误，只记 warning 并继续用剩余有效片段 */
export function warnPeakRule(rule: PeakRule): void {
    for (const warning of rule.warnings) logger.warning(warning);
}
