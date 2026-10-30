// 活跃时间窗口（L2 纯函数）：全局「触发活跃时间」模板与链 active_time 门共用同一套解析/判定。
//
// 与旧实现的关系：旧 session/rhythm.ts 只支持单段（start/end/segs），且 activeTimeInfo 是
// 分钟数；本文件改为支持「多段」并保留分钟数内部表示，旧 rhythm 的纯函数在 M2 由本文件取代。
// 段语义（沿用现状）：segs = 分段数，每段最多触发 1 次；缺省 1。

/** 一个活跃时段（分钟数内部表示，支持跨 0 点） */
export interface ActiveTimeSegment {
    /** 开始（当天分钟数，0~1439） */
    start: number;
    /** 结束（当天分钟数；跨零点时 end < start） */
    end: number;
    /** 分段数：时段等分为 segs 段，每段最多触发 1 次 */
    segs: number;
}

export interface ParsedTimeSegments {
    segments: ActiveTimeSegment[];
    warnings: string[];
}

const HH_MM = /^(\d{1,2}):(\d{2})$/;

/** 解析单条 `HH:mm-HH:mm[-次数]`；失败返回错误文案 */
export function parseTimeSegment(text: string): { segment?: ActiveTimeSegment; error?: string } {
    const raw = String(text ?? '').trim();
    if (!raw) return { error: '' };
    const parts = raw.split('-').map(item => item.trim()).filter(item => item !== '');
    if (parts.length < 2) return { error: `活跃时间格式错误（应为 HH:mm-HH:mm[-次数]）：${raw}` };
    const startMatch = HH_MM.exec(parts[0]);
    const endMatch = HH_MM.exec(parts[1]);
    if (!startMatch || !endMatch) return { error: `活跃时间格式错误（应为 HH:mm-HH:mm[-次数]）：${raw}` };
    const startH = Number(startMatch[1]);
    const startM = Number(startMatch[2]);
    const endH = Number(endMatch[1]);
    const endM = Number(endMatch[2]);
    if (startH > 23 || endH > 23 || startM > 59 || endM > 59) {
        return { error: `活跃时间超出范围：${raw}` };
    }
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;
    if (start === end) return { error: `活跃时间开始和结束不能相同：${raw}` };
    const duration = end >= start ? end - start : end + 24 * 60 - start;
    let segs = 1;
    if (parts.length >= 3) {
        if (!/^\d+$/.test(parts[2])) return { error: `活跃次数必须是正整数：${raw}` };
        segs = Number(parts[2]);
        if (segs < 1) return { error: `活跃次数必须 ≥1：${raw}` };
    }
    if (segs > duration) return { error: `活跃次数不能大于时段分钟数：${raw}` };
    return { segment: { start, end, segs } };
}

function segmentsOverlap(a: ActiveTimeSegment, b: ActiveTimeSegment): boolean {
    const toRange = (seg: ActiveTimeSegment): Array<[number, number]> => {
        if (seg.end >= seg.start) return [[seg.start, seg.end]];
        return [[seg.start, 24 * 60], [0, seg.end]];
    };
    for (const [aStart, aEnd] of toRange(a)) {
        for (const [bStart, bEnd] of toRange(b)) {
            if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) return true;
            // 边界相接（19:00-20:00 与 20:00-21:00）不算重叠
        }
    }
    return false;
}

/** 解析全局模板（多条）：空条目跳过；重叠的后者 WARN 丢弃（先配的优先） */
export function parseTimeSegments(texts: readonly string[] | undefined): ParsedTimeSegments {
    const segments: ActiveTimeSegment[] = [];
    const warnings: string[] = [];
    for (const text of texts || []) {
        const parsed = parseTimeSegment(text);
        if (parsed.error) {
            if (parsed.error) warnings.push(parsed.error);
            continue;
        }
        if (!parsed.segment) continue;
        if (segments.some(item => segmentsOverlap(item, parsed.segment!))) {
            warnings.push(`活跃时间重叠，已忽略后者：${String(text).trim()}`);
            continue;
        }
        segments.push(parsed.segment);
    }
    return { segments, warnings };
}

function isInSegment(segment: ActiveTimeSegment, minuteOfDay: number): boolean {
    if (segment.end >= segment.start) return minuteOfDay >= segment.start && minuteOfDay < segment.end;
    return minuteOfDay >= segment.start || minuteOfDay < segment.end;
}

/** 当前时间落在第几个时段（-1=不在任何时段） */
export function activeSegmentIndex(segments: readonly ActiveTimeSegment[], now: Date = new Date()): number {
    const minute = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < segments.length; i++) {
        if (isInSegment(segments[i], minute)) return i;
    }
    return -1;
}

/** 当前时段内的段索引（第几段，0-based；不在时段返回 -1） */
export function activeSubSegmentIndex(segment: ActiveTimeSegment, now: Date = new Date()): number {
    const minute = now.getHours() * 60 + now.getMinutes();
    if (!isInSegment(segment, minute)) return -1;
    const duration = segment.end >= segment.start ? segment.end - segment.start : segment.end + 24 * 60 - segment.start;
    const offset = minute >= segment.start ? minute - segment.start : minute + 24 * 60 - segment.start;
    const segLen = duration / segment.segs;
    if (segLen <= 0) return 0;
    return Math.min(segment.segs - 1, Math.floor(offset / segLen));
}

/** 全部时段的下一触发时刻（unix 秒；无时段返回 -1）。时段内取下一个子段边界，时段外取最近的下一个开始点。 */
export function nextActivePoint(segments: readonly ActiveTimeSegment[], nowMs: number = Date.now(), random: () => number = Math.random): number {
    if (segments.length === 0) return -1;
    const now = new Date(nowMs);
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    const pointAt = (dayShift: number, minuteOfDay: number): number => {
        const date = new Date(nowMs);
        date.setDate(date.getDate() + dayShift);
        date.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, Math.floor(random() * 60), 0);
        return date.getTime();
    };
    let best = Number.POSITIVE_INFINITY;
    for (const segment of segments) {
        const duration = segment.end >= segment.start ? segment.end - segment.start : segment.end + 24 * 60 - segment.start;
        const segLen = Math.max(1, duration / Math.max(1, segment.segs));
        let minutesUntil: number;
        if (isInSegment(segment, nowMinute)) {
            const sub = activeSubSegmentIndex(segment, now);
            const offset = nowMinute >= segment.start ? nowMinute - segment.start : nowMinute + 24 * 60 - segment.start;
            const nextOffset = (sub + 1) * segLen;
            minutesUntil = nextOffset > offset ? nextOffset - offset : duration - offset;
        } else {
            minutesUntil = (segment.start - nowMinute + 24 * 60) % (24 * 60);
            if (minutesUntil === 0) minutesUntil = 24 * 60;
        }
        const absolute = nowMinute + Math.max(1, Math.floor(minutesUntil));
        const candidate = pointAt(Math.floor(absolute / (24 * 60)), absolute % (24 * 60));
        if (candidate > nowMs && candidate < best) best = candidate;
    }
    return Number.isFinite(best) ? Math.floor(best / 1000) : -1;
}
