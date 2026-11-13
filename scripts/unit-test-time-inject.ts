// #163 D4 时间层单测（T13 组）：fmtDateTz / formatGap / wakeMarker / writeWakeMarker / wakeSession marker /
// renderTimerText / renderActiveHoursText。独立 bundle，避免污染按域拆分的主入口。
import assert from 'node:assert/strict';

import { renderActiveHoursText, renderTimerText } from '../src/timer';
import { wakeSession, writeWakeMarker } from '../src/trigger/wake';
import { formatGap, SYSTEM_NAME, wakeMarker } from '../src/utils/protocol';
import { fmtDateTz } from '../src/utils/string';

/** 固定时刻：UTC 2026-11-09 14:13:54 → 东八区 22:13:54 */
const FIXED_TS = Math.floor(Date.UTC(2026, 10, 9, 14, 13, 54) / 1000);

interface CapturedWrite { text: string; systemName?: string }

function makeCapturingSession(lastMessageAt: () => number) {
    const writes: CapturedWrite[] = [];
    let chatCalled = 0;
    const session = {
        setting: { enabled: () => true },
        hasBucketToken: () => true,
        lastMessageAt,
        context: {
            addSystemUserMessage(text: string, systemName?: string) {
                writes.push({ text, systemName });
            },
        },
        save() { /* noop */ },
        async chat() { chatCalled++; return 'fired' as const; },
    };
    return { session, writes, chatCount: () => chatCalled };
}

export const tests = {
    /** T13-6：格式必须是 `YYYY-MM-DD HH:mm:ss ±HH:MM`，且按显式偏移换算墙钟时间 */
    testFmtDateTzExplicitOffset(): void {
        assert.equal(fmtDateTz(FIXED_TS, 480), '2026-11-09 22:13:54 +08:00');
        assert.equal(fmtDateTz(FIXED_TS, 0), '2026-11-09 14:13:54 +00:00');
        assert.equal(fmtDateTz(FIXED_TS, -300), '2026-11-09 09:13:54 -05:00');
    },

    /** T13-7：缺省偏移 = 宿主本地时区，格式与偏移互逆 */
    testFmtDateTzDefaultLocal(): void {
        const out = fmtDateTz(FIXED_TS);
        assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
        const offsetMin = -new Date(FIXED_TS * 1000).getTimezoneOffset();
        const sign = offsetMin >= 0 ? '+' : '-';
        const abs = Math.abs(offsetMin);
        const pad = (n: number) => String(n).padStart(2, '0');
        assert.ok(out.endsWith(` ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`), `时区偏移不匹配: ${out}`);
    },

    /** 非法/缺省入参不抛错（健壮性） */
    testFmtDateTzInvalidInput(): void {
        assert.match(fmtDateTz(Number.NaN), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
    },

    /** T13-9/10：相对时长格式 3h12m / 4m / 2d5h / 1h */
    testFormatGapShapes(): void {
        assert.equal(formatGap(0), '1m');
        assert.equal(formatGap(240), '4m');
        assert.equal(formatGap(3600), '1h');
        assert.equal(formatGap(11520), '3h12m');
        assert.equal(formatGap(190800), '2d5h');
        assert.equal(formatGap(-5), '1m');
    },

    /** wake marker 文本：`[wake] <cause>`，cause 归一为小写连字符；≥1h 才有 [gap] */
    testWakeMarkerText(): void {
        assert.equal(wakeMarker('judge'), '[wake] judge');
        assert.equal(wakeMarker('active hours', 11520), '[wake] active-hours [gap] 3h12m');
        assert.equal(wakeMarker(''), '[wake] wake');
        assert.equal(wakeMarker('AT'), '[wake] at');
    },

    /** SYSTEM_NAME 增 wake（协议标记走 protocol.ts） */
    testSystemNameHasWake(): void {
        assert.equal(SYSTEM_NAME.wake, 'wake');
    },

    /** T13-8/9/10：writeWakeMarker 写 `[system:wake]`，≥1h 追加 [gap]，<1h 不追加 */
    async testWriteWakeMarkerGap(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const far = makeCapturingSession(() => now - 11520);
        await writeWakeMarker(far.session as never, 'judge');
        assert.equal(far.writes.length, 1);
        assert.equal(far.writes[0].systemName, 'wake');
        assert.match(far.writes[0].text, /^\[wake\] judge \[gap\] 3h12m$/);

        const near = makeCapturingSession(() => now - 120);
        await writeWakeMarker(near.session as never, 'external');
        assert.equal(near.writes[0].text, '[wake] external');
    },

    /** 空会话（lastMessageAt=0）不写 [gap] */
    async testWriteWakeMarkerEmptySession(): Promise<void> {
        const s = makeCapturingSession(() => 0);
        await writeWakeMarker(s.session as never, 'judge');
        assert.equal(s.writes[0].text, '[wake] judge');
    },

    /** T13-13：wakeSession 有 wakeText 时只写触发提示、不写 marker */
    async testWakeSessionWithTextNoMarker(): Promise<void> {
        const s = makeCapturingSession(() => 0);
        const outcome = await wakeSession(s.session as never, {} as never, {} as never, {
            kind: 'rule',
            wakeText: 'please speak',
            cause: 'rule',
        });
        assert.equal(outcome, 'fired');
        assert.equal(s.writes.length, 1);
        assert.equal(s.writes[0].text, 'please speak');
        assert.equal(s.writes[0].systemName, SYSTEM_NAME.triggerRule);
    },

    /** T13-8：wakeSession 无 wakeText 时补 `[wake]` marker（active-hours 新语义路径） */
    async testWakeSessionWithoutTextWritesMarker(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const s = makeCapturingSession(() => now - 120);
        const outcome = await wakeSession(s.session as never, {} as never, {} as never, {
            kind: 'mode',
            reason: '活跃时间',
            cause: 'active-hours',
        });
        assert.equal(outcome, 'fired');
        assert.equal(s.writes.length, 1);
        assert.equal(s.writes[0].systemName, SYSTEM_NAME.wake);
        assert.equal(s.writes[0].text, '[wake] active-hours');
        assert.equal(s.chatCount(), 1);
    },

    /** T13-14：target 定时器文本不含 "现在"的绝对时间（无 Triggered at） */
    testRenderTimerTextTarget(): void {
        const text = renderTimerText('target', { set: FIXED_TS, target: FIXED_TS + 3600, prompt: 'do it' });
        assert.ok(text.includes('Timer set at: 2026-11-09 22:13:54'));
        assert.ok(text.includes('Target time: 2026-11-09 23:13:54'));
        assert.ok(text.includes('Prompt: do it'));
        assert.equal(text.includes('Triggered at:'), false);
    },

    /** T13-15：interval 定时器用秒数（修掉 fmtDate(interval) 渲染成 1970 的 bug） */
    testRenderTimerTextIntervalUnit(): void {
        const text = renderTimerText('interval', { set: FIXED_TS, intervalSec: 3600, count: 3, prompt: 'ping' });
        assert.ok(text.includes('Interval: 3600s'), text);
        assert.equal(text.includes('1970'), false);
        assert.ok(text.includes('Remaining triggers: 2'));
        assert.ok(text.includes('Timer set at: 2026-11-09 22:13:54'));
        assert.equal(text.includes('Triggered at:'), false);
        const unlimited = renderTimerText('interval', { set: FIXED_TS, intervalSec: 300, count: -1, prompt: 'x' });
        assert.ok(unlimited.includes('Interval: 300s'));
        assert.ok(unlimited.includes('Remaining triggers: unlimited'));
    },

    /** T13-16：active-hours 旧语义只给相对间隔（≥1h 才出现），无绝对时间 */
    testRenderActiveHoursText(): void {
        const now = FIXED_TS;
        const base = renderActiveHoursText(0, now);
        assert.equal(base, 'It is now your active window. Say something.');
        assert.equal(renderActiveHoursText(now - 1800, now), base);
        const aged = renderActiveHoursText(now - 7200, now);
        assert.ok(aged.includes('It has been 2h since the last message.'), aged);
        assert.equal(/\d{4}-\d{2}-\d{2}/.test(aged), false, '不得含绝对日期');
    },
};
