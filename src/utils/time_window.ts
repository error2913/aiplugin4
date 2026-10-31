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

/**
 * 链 active_time 源门（HH:mm 字符串 + segs）→ 单段。
 * 校验口径与 parseTimeSegment 一致（start≠end、segs ≤ 时段分钟数）；非法返回 null。
 */
export function parseActiveTimeGate(gate: { start: string; end: string; segs?: number }): ActiveTimeSegment | null {
    const segs = Math.max(1, Math.floor(gate.segs ?? 1));
    const parsed = parseTimeSegment(gate.start + '-' + gate.end + '-' + segs);
    return parsed.segment ?? null;
}

/** 时段长度（分钟，支持跨 0 点） */
function segmentDuration(segment: ActiveTimeSegment): number {
    return segment.end >= segment.start ? segment.end - segment.start : segment.end + 24 * 60 - segment.start;
}

/** 绝对分钟（可 >1440，表示次日）→ 毫秒时间戳 */
function pointAtAbsoluteMinute(nowMs: number, absoluteMinute: number): number {
    const dayShift = Math.floor(absoluteMinute / (24 * 60));
    const minute = ((absoluteMinute % (24 * 60)) + 24 * 60) % (24 * 60);
    const date = new Date(nowMs);
    date.setDate(date.getDate() + dayShift);
    date.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return date.getTime();
}

/**
 * 当前子段的唯一 occurrence（当天序号×segs + 子段下标；不在窗口返回 -1）。
 * 用于「每段最多触发 1 次」的持久去重（重载/重复投递不会重复触发同一段）。
 */
export function activeSubSegmentOccurrence(segment: ActiveTimeSegment, nowMs: number = Date.now()): number {
    const now = new Date(nowMs);
    const minute = now.getHours() * 60 + now.getMinutes();
    if (!isInSegment(segment, minute)) return -1;
    const sub = activeSubSegmentIndex(segment, now);
    if (sub < 0) return -1;
    const dayNumber = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 86400000);
    return dayNumber * Math.max(1, segment.segs) + sub;
}

/**
 * 单段规则的下一个子段开始时刻（unix 秒；-1=无法计算）。
 * - 窗口内：下一子段起点；已在最后一段 → 下一个窗口开始（次日/跨天）；
 * - 窗口外：下一个窗口开始。
 */
export function nextActiveTimeStart(segment: ActiveTimeSegment, nowMs: number = Date.now()): number {
    const now = new Date(nowMs);
    const nowMinute = now.getHours() * 60 + now.getMinutes();
    const duration = segmentDuration(segment);
    const segs = Math.max(1, segment.segs);
    const segLen = duration / segs;
    const inWindow = isInSegment(segment, nowMinute);
    let targetMinute: number;
    if (inWindow) {
        const sub = activeSubSegmentIndex(segment, now);
        const currentAbsolute = nowMinute < segment.start ? nowMinute + 24 * 60 : nowMinute;
        const baseStart = nowMinute < segment.start ? segment.start + 24 * 60 : segment.start;
        if (sub + 1 < segs) {
            targetMinute = baseStart + (sub + 1) * segLen;
        } else {
            targetMinute = segment.start + 24 * 60;
        }
        if (targetMinute <= currentAbsolute) targetMinute = segment.start + 24 * 60;
    } else {
        targetMinute = segment.start > nowMinute ? segment.start : segment.start + 24 * 60;
    }
    return Math.floor(pointAtAbsoluteMinute(nowMs, targetMinute) / 1000);
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
