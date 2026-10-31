// 定时器参数（L2 纯逻辑，唯一校验实现）：set_timer 工具 / 全局「默认定时器」/ 链 timer 门共用。
//
// 为什么单独抽出来：三处参数与校验必须完全一致（作者明确要求），任何一处各写一份就会漂移；
// 放在 utils（L2）可被 trigger(L2) 与 tool(L3) 同时引用，且不引入跨层依赖。
// 语义严格对齐现有 set_timer（src/tool/tools/core/tool_time.ts:54-107），并修掉 target 缺省
// 年份导致 1900 年的旧 bug（target 必须显式给年/月/日）。

export interface TimerSpec {
    /** target=绝对时间一次性；interval=周期 */
    types: 'target' | 'interval';
    years?: number;
    months?: number;
    days?: number;
    hours?: number;
    minutes: number;
    /** interval 触发次数：-1 无限；target 固定 1 */
    count: number;
    /** 多条唤醒提示（1~10 条，每条 ≤500 字），fire 时随机抽一条 */
    prompts: string[];
}

/** 规范化后的定时器参数（targetAt 为 unix 秒；intervalSec 为秒） */
export interface NormalizedTimerSpec extends TimerSpec {
    /** target 型：触发时刻（unix 秒） */
    targetAt?: number;
    /** interval 型：间隔（秒） */
    intervalSec?: number;
}

export interface TimerSpecResult {
    ok: boolean;
    spec?: NormalizedTimerSpec;
    errors: string[];
}

export const TIMER_PROMPTS_MAX = 10;
export const TIMER_PROMPT_MAX_CHARS = 500;
export const TIMER_COUNT_MAX = 30;
export const TIMER_SPAN_MAX_MINUTES = 365 * 24 * 60;

function toInt(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** 读取 prompts：数组或单字符串（单字符串仅兼容旧调用，等价于 1 条） */
export function readPrompts(value: unknown, errors: string[]): string[] {
    let list: unknown[];
    if (Array.isArray(value)) list = value;
    else if (typeof value === 'string' && value.trim()) list = [value];
    else {
        errors.push('prompts 必须是非空字符串数组（1~10 条）');
        return [];
    }
    if (list.length < 1 || list.length > TIMER_PROMPTS_MAX) {
        errors.push(`prompts 条数必须在 1~${TIMER_PROMPTS_MAX} 之间`);
        return [];
    }
    const out: string[] = [];
    for (const item of list) {
        if (typeof item !== 'string' || !item.trim()) {
            errors.push('prompts 每条必须是非空字符串');
            continue;
        }
        if (item.length > TIMER_PROMPT_MAX_CHARS) {
            errors.push(`prompts 每条不能超过 ${TIMER_PROMPT_MAX_CHARS} 字`);
            continue;
        }
        out.push(item);
    }
    return out;
}

/**
 * 校验并规范化定时器参数。
 * @param raw 外部输入（工具 args / TOML 段 / 门 JSON）
 * @param now 当前时间（毫秒，注入便于单测）
 */
export function validateTimerSpec(raw: unknown, now: number = Date.now()): TimerSpecResult {
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, errors: ['定时器参数必须是对象'] };
    }
    const obj = raw as Record<string, unknown>;
    const types = obj.types;
    if (types !== 'target' && types !== 'interval') {
        return { ok: false, errors: ['types 必须是 target 或 interval'] };
    }

    const years = obj.years === undefined ? 0 : toInt(obj.years);
    const months = obj.months === undefined ? 0 : toInt(obj.months);
    const days = obj.days === undefined ? 0 : toInt(obj.days);
    const hours = obj.hours === undefined ? 0 : toInt(obj.hours);
    // minutes 允许省略（等价 0）：interval 常用“小时/天”表达，set_timer 工具侧仍会显示该参数
    const minutes = obj.minutes === undefined ? 0 : toInt(obj.minutes);
    if (years === null) errors.push('years 必须是整数');
    if (months === null) errors.push('months 必须是整数');
    if (days === null) errors.push('days 必须是整数');
    if (hours === null) errors.push('hours 必须是整数');
    if (minutes === null) errors.push('minutes 必须是整数');

    const prompts = readPrompts(obj.prompts, errors);
    if (errors.length > 0) return { ok: false, errors };

    const y = years as number;
    const mo = months as number;
    const d = days as number;
    const h = hours as number;
    const min = minutes as number;
    if (y < 0 || mo < 0 || d < 0 || h < 0 || min < 0) {
        return { ok: false, errors: ['时间参数不能为负数'] };
    }

    if (types === 'target') {
        // target 必须显式给出年/月/日：旧实现缺省 0 → 1900 年（已修）
        if (obj.years === undefined || obj.months === undefined || obj.days === undefined) {
            return { ok: false, errors: ['target 定时器必须提供 years/months/days'] };
        }
        if (mo < 1 || mo > 12) return { ok: false, errors: ['months 必须在 1~12'] };
        if (d < 1 || d > 31) return { ok: false, errors: ['days 必须在 1~31'] };
        if (min > 59) return { ok: false, errors: ['minutes 必须在 0~59'] };
        if (h > 23) return { ok: false, errors: ['hours 必须在 0~23'] };
        const t = new Date(y, mo - 1, d, h, min).getTime();
        if (!Number.isFinite(t)) return { ok: false, errors: ['时间设置错误'] };
        if (t < now) return { ok: false, errors: ['目标时间不能早于当前时间'] };
        if (t - now > TIMER_SPAN_MAX_MINUTES * 60 * 1000) return { ok: false, errors: ['目标时间不能超过1年'] };
        return {
            ok: true,
            errors: [],
            spec: { types, years: y, months: mo, days: d, hours: h, minutes: min, count: 1, prompts, targetAt: Math.floor(t / 1000) },
        };
    }

    // interval
    if (min > 59) return { ok: false, errors: ['minutes 必须在 0~59'] };
    const totalMinutes = y * 365 * 24 * 60 + mo * 30 * 24 * 60 + d * 24 * 60 + h * 60 + min;
    if (totalMinutes <= 0) return { ok: false, errors: ['间隔时间必须大于0'] };
    if (totalMinutes > TIMER_SPAN_MAX_MINUTES) return { ok: false, errors: ['间隔时间不能大于1年'] };
    const count = obj.count === undefined ? 1 : toInt(obj.count);
    if (count === null) return { ok: false, errors: ['count 必须是整数'] };
    if (count < -1 || count === 0) return { ok: false, errors: ['触发次数不能小于-1或等于0'] };
    if (count === -1 && totalMinutes < 12 * 60) return { ok: false, errors: ['无限次触发间隔时间不能小于12小时'] };
    if (count > TIMER_COUNT_MAX) return { ok: false, errors: [`触发次数不能大于${TIMER_COUNT_MAX}次`] };
    return {
        ok: true,
        errors: [],
        spec: { types, years: y, months: mo, days: d, hours: h, minutes: min, count, prompts, intervalSec: totalMinutes * 60 },
    };
}

/** 从多条提示里随机抽一条（空→由调用方回退内置文案） */
export function pickPrompt(prompts: string[] | undefined, random: () => number = Math.random): string {
    if (!prompts || prompts.length === 0) return '';
    const index = Math.min(prompts.length - 1, Math.max(0, Math.floor(random() * prompts.length)));
    return prompts[index];
}

/** 定时器参数的展示摘要（命令/工具回显用） */
export function summarizeTimerSpec(spec: TimerSpec): string {
    const parts: string[] = [];
    if (spec.types === 'target') {
        parts.push(`target ${spec.years ?? 0}-${String(spec.months ?? 0).padStart(2, '0')}-${String(spec.days ?? 0).padStart(2, '0')} ${String(spec.hours ?? 0).padStart(2, '0')}:${String(spec.minutes).padStart(2, '0')}`);
    } else {
        const units: string[] = [];
        if (spec.years) units.push(`${spec.years}年`);
        if (spec.months) units.push(`${spec.months}月`);
        if (spec.days) units.push(`${spec.days}天`);
        if (spec.hours) units.push(`${spec.hours}小时`);
        if (spec.minutes) units.push(`${spec.minutes}分钟`);
        parts.push(`interval ${units.join('') || '0分钟'}`);
        parts.push(spec.count === -1 ? '无限次' : `${spec.count}次`);
    }
    parts.push(`提示${spec.prompts.length}条`);
    return parts.join(' · ');
}
