// 用量限制内核单测（P0 §7.2 的 8 组用例）。
//
// 约束：
// - 每个用例显式 `QuotaManager.configure(() => view({...}))`，**不依赖 seal 桩的默认值**
//   （seal-env.cjs 的 `getBoolConfig` 默认 true、`getIntConfig` 默认 0，直接用会把预算算成 0）；
// - 时间一律用假时钟（`setHost({clock})`），不 sleep；
// - 存储用内存 Map，`resetStoreCacheForTest()` 清模块级缓存。
import assert from 'node:assert/strict';

import type { QuotaConfigView } from '../src/config/configs/quota';
import QuotaConfig, { DEFAULT_PEAK_TEMPLATE, QUOTA_CONFIG_KEYS } from '../src/config/configs/quota';
import { setHost } from '../src/core/host';
import { QuotaManager, RESERVE_MAX_COMPLETION } from '../src/quota/manager';
import { emptyStore, flushNow, isDirty, loadStore, QUOTA_STORAGE_KEY, resetStore, resetStoreCacheForTest } from '../src/quota/store';
import { QuotaExceededError } from '../src/quota/types';
import { expandPeakSegments, isoDayOf, minuteOfDayOf, nextResetAt, parsePeakTemplate, peakPercentAt, windowBoundsOf, windowKeyOf } from '../src/quota/window';
import { parseTimeRange } from '../src/utils/time_window';

class MemoryStorage {
    map = new Map<string, string>();
    get(key: string): string | null {
        if (!this.map.has(key)) throw new Error(`key not found: ${key}`);
        return this.map.get(key)!;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

let storage = new MemoryStorage();
let clockNow = 0;

function installHost(at: number): void {
    clockNow = at;
    storage = new MemoryStorage();
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => clockNow },
        fetch: (() => { throw new Error('no fetch in quota tests'); }) as never,
        ext: {} as never,
    });
}

/** 重装内存环境（每个用例开头调一次） */
function setup(at: number, over: Partial<QuotaConfigView> = {}): void {
    installHost(at);
    resetStoreCacheForTest();
    QuotaManager.reset();
    QuotaManager.releaseAllInflightForTest();
    QuotaManager.clearNotifiedForTest();
    QuotaManager.configure(() => view(over));
}

/** 默认视图：关闭、2M/10M/40M、全 100、无峰时 */
function view(over: Partial<QuotaConfigView> = {}): QuotaConfigView {
    return {
        ENABLED: false,
        LIMIT_5H: 2_000_000,
        LIMIT_WEEK: 10_000_000,
        LIMIT_MONTH: 40_000_000,
        SESSION_PERCENT: 100,
        USER_PERCENT: 100,
        PEAK_RULE: { segments: [], warnings: [] },
        PURPOSE_PERCENT: {
            summarization: 100,
            judge: 100,
            'image-understanding': 100,
            'text-embedding': 100,
        },
        NOTIFY_ON_LIMIT: true,
        ...over,
    };
}

/** 本地时间构造（避免 UTC 偏移影响窗口键断言） */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

/** 便捷：把进程单例的视图换成指定覆盖 */
function useView(over: Partial<QuotaConfigView>): void {
    QuotaManager.configure(() => view(over));
}

export const tests: Record<string, () => void | Promise<void>> = {
    // ---------------- 第 1 组：窗口键 ----------------

    /** 5 小时窗口按 00/05/10/15/20 切段：14:59 在 slot 2，15:00 进 slot 3 */
    testWindowKeyFiveHourBoundary() {
        setup(at(2026, 11, 5, 14, 59));
        assert.equal(windowKeyOf('h', clockNow), '2026-11-05:2');
        clockNow = at(2026, 11, 5, 15, 0);
        assert.equal(windowKeyOf('h', clockNow), '2026-11-05:3');
        // 边界内不改键
        clockNow = at(2026, 11, 5, 19, 59);
        assert.equal(windowKeyOf('h', clockNow), '2026-11-05:3');
    },

    /** 末段 20:00-24:00 只有 4 小时，且跨到次日 00:00 结束 */
    testWindowKeyLastSlotIsFourHours() {
        setup(at(2026, 11, 5, 20, 0));
        assert.equal(windowKeyOf('h', clockNow), '2026-11-05:4');
        const bounds = windowBoundsOf('h', clockNow);
        assert.equal(bounds.end - bounds.start, 4 * 60 * 60 * 1000, '末段应只有 4 小时');
        assert.equal(bounds.end, at(2026, 11, 6, 0, 0));
        clockNow = at(2026, 11, 6, 0, 0);
        assert.equal(windowKeyOf('h', clockNow), '2026-11-06:0', '跨日后是新键');
    },

    /** 周窗口以周一为起点；月窗口按自然月 */
    testWindowKeyWeekAndMonth() {
        // 2026-11-05 是周四
        setup(at(2026, 11, 5, 10, 0));
        assert.equal(isoDayOf(clockNow), 4);
        assert.equal(windowKeyOf('w', clockNow), '2026-11-02');
        assert.equal(windowKeyOf('m', clockNow), '2026-11');
        // 周日属于同一周（周一起算）
        clockNow = at(2026, 11, 8, 23, 0);
        assert.equal(isoDayOf(clockNow), 7);
        assert.equal(windowKeyOf('w', clockNow), '2026-11-02');
        // 周一 00:00 换周
        clockNow = at(2026, 11, 9, 0, 0);
        assert.equal(windowKeyOf('w', clockNow), '2026-11-09');
        assert.equal(windowKeyOf('m', clockNow), '2026-11');
    },

    /** 跨年：12-31 → 01-01 时月键与日键都要正确翻转 */
    testWindowKeyCrossYear() {
        setup(at(2026, 12, 31, 23, 30));
        assert.equal(windowKeyOf('m', clockNow), '2026-12');
        assert.equal(windowKeyOf('h', clockNow), '2026-12-31:4');
        clockNow = at(2027, 1, 1, 0, 5);
        assert.equal(windowKeyOf('m', clockNow), '2027-01');
        assert.equal(windowKeyOf('h', clockNow), '2027-01-01:0');
        // 2027-01-01 是周五；本周一为 2026-12-28（跨年周）
        assert.equal(windowKeyOf('w', clockNow), '2026-12-28');
    },

    /** 时钟回拨：不重置计数、窗口键保持旧值（避免用户白拿额度） */
    testClockRollbackKeepsCounters() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        const handle = QuotaManager.admitChat({ sessionId: 'S1', userId: 'U1' }, 100);
        handle.release();
        QuotaManager.record('chat', 400, { sessionId: 'S1', userId: 'U1' });
        assert.equal(QuotaManager.status({ sessionId: 'S1' }).windows.h.used, 400);

        // 回拨 2 小时：键本该退回 slot 1，但计数必须保留
        clockNow = at(2026, 11, 5, 8, 0);
        const after = QuotaManager.status({ sessionId: 'S1' });
        assert.equal(after.windows.h.used, 400, '回拨后计数不能归零');
        assert.equal(after.windows.h.key, '2026-11-05:2', '窗口键应钉在回拨前');
    },

    /** 惰性重置：窗口键变化后旧计数立即视为 0，无需任何定时器 */
    testLazyResetOnWindowChange() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        QuotaManager.record('chat', 900, { sessionId: 'S1' });
        assert.equal(QuotaManager.status().windows.h.used, 900);
        clockNow = at(2026, 11, 5, 15, 0); // 进下一 5h 段
        assert.equal(QuotaManager.status().windows.h.used, 0, '新窗口从 0 起算');
        assert.equal(QuotaManager.status().windows.w.used, 900, '周窗口不受 5h 段影响');
    },

    // ---------------- 第 2 组：时段解析 ----------------

    testParseTimeRangeBasic() {
        assert.deepEqual(parseTimeRange('09:00-12:00'), { range: { start: 540, end: 720 } });
        assert.deepEqual(parseTimeRange(' 9:05-12:30 '), { range: { start: 545, end: 750 } });
        assert.deepEqual(parseTimeRange(''), { error: '' }, '空串不是错误');
    },

    testParseTimeRangeCrossMidnight() {
        const parsed = parseTimeRange('22:00-02:00');
        assert.deepEqual(parsed, { range: { start: 1320, end: 120 } }, '跨 0 点保留 end<start');
    },

    testParseTimeRangeErrors() {
        assert.match(parseTimeRange('25:00-01:00').error ?? '', /超出范围/, '小时越界');
        assert.match(parseTimeRange('09:60-10:00').error ?? '', /超出范围/, '分钟越界');
        assert.match(parseTimeRange('09:00-09:00').error ?? '', /不能相同/, '起止相同');
        assert.match(parseTimeRange('9:00~10:00').error ?? '', /格式错误/, '分隔符错误');
        assert.match(parseTimeRange('09:00-12:00-30').error ?? '', /格式错误/, '多出第三段');
    },

    /** 四种合法形态：仅时段 / 单日 / 区间 / 列表 */
    testPeakTemplateLegalFourForms() {
        const bare = parsePeakTemplate(['09:00-12:00-30']);
        assert.equal(bare.warnings.length, 0);
        assert.equal(bare.segments.length, 7, '无周几 = 每天一段');

        const single = parsePeakTemplate(['3 09:00-12:00-50']);
        assert.equal(single.warnings.length, 0);
        assert.deepEqual(single.segments.map(s => s.day), [3]);

        const range = parsePeakTemplate(['1-5 09:00-12:00-30']);
        assert.deepEqual(range.segments.map(s => s.day), [1, 2, 3, 4, 5]);

        const list = parsePeakTemplate(['1,3,5 20:00-22:00-50']);
        assert.deepEqual(list.segments.map(s => s.day), [1, 3, 5]);
        assert.deepEqual(list.segments.map(s => s.pct), [50, 50, 50]);

        const mixed = parsePeakTemplate(['1-3,7 10:00-12:00-20']);
        assert.deepEqual(mixed.segments.map(s => s.day), [1, 2, 3, 7], '区间+列表混用');
    },

    /** 七类非法输入各自给出 warning，且不产生片段 */
    testPeakTemplateInvalidSevenCases() {
        const cases: Array<[string, RegExp]> = [
            ['1-5 09:00 - 12:00-30', /限制时段重叠|格式错误/],
            ['0 09:00-12:00-30', /周几/],
            ['8 09:00-12:00-30', /周几/],
            ['5-1 09:00-12:00-30', /从小到大/],
            ['1-5 25:00-12:00-30', /时间范围|格式错误/],
            ['1-5 09:00-12:00-0', /百分比/],
            ['1-5 09:00-12:00-101', /百分比/],
        ];
        for (const [text, expected] of cases) {
            const rule = parsePeakTemplate([text]);
            assert.equal(rule.segments.length, 0, `${text} 不应产生片段`);
            assert.equal(rule.warnings.length, 1, `${text} 应恰好 1 条 warning`);
            assert.match(rule.warnings[0], expected, `${text} 的 warning 文案`);
            assert.match(rule.warnings[0], /第 1 框/, 'warning 必须带框号');
        }
    },

    /** 同一框内重复周几（1-3,2-4）要按 Set 去重 */
    testPeakTemplateDedupDays() {
        const rule = parsePeakTemplate(['1-3,2-4 09:00-12:00-30']);
        assert.deepEqual(rule.segments.map(s => s.day), [1, 2, 3, 4], '重叠的日应去重且升序');
    },

    /** 重叠的后者丢弃并 WARN（先配的优先） */
    testPeakTemplateOverlapDropsLater() {
        const rule = parsePeakTemplate(['1-5 09:00-12:00-30', '1-5 11:00-13:00-50']);
        assert.equal(rule.segments.length, 5, '第二条整体被丢弃');
        assert.ok(rule.segments.every(s => s.pct === 30));
        assert.ok(rule.warnings.some(w => /重叠/.test(w)));

        // 边界相接不算重叠
        const touching = parsePeakTemplate(['1 09:00-12:00-30', '1 12:00-15:00-50']);
        assert.equal(touching.segments.length, 2, '12:00 相接不算重叠');
        assert.equal(touching.warnings.length, 0);
    },

    /** 跨 0 点按**起始日**归属：周一 01:00 不命中，周六 01:00 命中 */
    testPeakTemplateCrossMidnightOwnership() {
        const rule = parsePeakTemplate(['1-5 22:00-02:00-30']);
        assert.equal(rule.warnings.length, 0);
        // 每周 5 段 → 每段跨 0 点拆成 2 条 = 10 条
        assert.equal(rule.segments.length, 10);

        const mondayAt1 = at(2026, 11, 2, 1, 0); // 周一
        assert.equal(isoDayOf(mondayAt1), 1);
        assert.equal(peakPercentAt(rule, mondayAt1).segment, null, '周一 01:00 属于「周日段」，不命中');

        const saturdayAt1 = at(2026, 11, 7, 1, 0); // 周六
        assert.equal(isoDayOf(saturdayAt1), 6);
        assert.equal(peakPercentAt(rule, saturdayAt1).pct, 30, '周六 01:00 命中（周五段延伸）');

        const mondayAt23 = at(2026, 11, 2, 23, 0);
        assert.equal(peakPercentAt(rule, mondayAt23).pct, 30, '周一 23:00 命中');
    },

    /** 空模板 = 不收紧，绝不回退默认 */
    testPeakTemplateEmptyDoesNotFallback() {
        for (const empty of [[], [''], ['  ']]) {
            const rule = parsePeakTemplate(empty as string[]);
            assert.equal(rule.segments.length, 0, '空模板不应有任何片段');
            assert.equal(rule.warnings.length, 0, '空模板不应告警');
            assert.equal(peakPercentAt(rule, at(2026, 11, 5, 10, 0)).pct, 100, '空模板系数必须是 100');
        }
    },

    /** 命中判定是半开区间：开始时刻命中、结束时刻不命中 */
    testPeakPercentAtHalfOpen() {
        const rule = parsePeakTemplate(['1-5 09:00-12:00-30']);
        const thursday = (hour: number, minute = 0): number => at(2026, 11, 5, hour, minute);
        assert.equal(peakPercentAt(rule, thursday(8, 59)).pct, 100, '开始前一分钟不命中');
        assert.equal(peakPercentAt(rule, thursday(9, 0)).pct, 30, '开始时刻命中');
        assert.equal(peakPercentAt(rule, thursday(11, 59)).pct, 30, '结束前一分钟命中');
        assert.equal(peakPercentAt(rule, thursday(12, 0)).pct, 100, '结束时刻不命中');
    },

    // ---------------- 第 3 组：预算公式 ----------------

    /** 0 = 不限，且必须以 B 判定（不能先乘系数） */
    testBudgetZeroMeansUnlimited() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 0, LIMIT_WEEK: 0, LIMIT_MONTH: 0 });
        assert.equal(QuotaManager.checkChat({ sessionId: 'S1' }), null, '0=不限，任何用量都放行');
        const handle = QuotaManager.admitChat({ sessionId: 'S1' }, 10);
        handle.release();
        assert.equal(QuotaManager.status().windows.h.limit, Infinity);
    },

    /** B=1、峰时 30% ⇒ 预算 max(1, floor(1*0.3)) = 1，不是 0、更不是「不限」 */
    testBudgetOneWithPeakIsOne() {
        const rule = parsePeakTemplate(['1-5 09:00-12:00-30']);
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1, PEAK_RULE: rule });
        assert.equal(QuotaManager.status().windows.h.limit, 1);
    },

    /** 峰时系数向下传播到会话/个人预算 */
    testBudgetFloorAndPeakPropagation() {
        const rule = parsePeakTemplate(['1-5 09:00-12:00-30']);
        setup(at(2026, 11, 5, 10, 0), {
            ENABLED: true,
            LIMIT_5H: 1_000_000,
            SESSION_PERCENT: 50,
            USER_PERCENT: 10,
            PEAK_RULE: rule,
        });
        const status = QuotaManager.status({ sessionId: 'S1', userId: 'U1' });
        assert.equal(status.windows.h.limit, 300_000, '1,000,000 × 0.3');
        assert.equal(status.session?.limit, 150_000, '会话档是有效总预算 × 50%');
        assert.equal(status.user?.limit, 30_000, '个人档是有效总预算 × 10%');
        assert.equal(status.peakPercent, 0.3);
        assert.equal(status.peakSegment, '1-5 09:00-12:00-30');
    },

    /** 用途不占对话总量：各记各的，总量只看 chat */
    testPurposeDoesNotPolluteTotal() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true });
        QuotaManager.record('summarization', 500);
        QuotaManager.record('chat', 300, { sessionId: 'S1' });
        const status = QuotaManager.status({ sessionId: 'S1' });
        assert.equal(status.windows.h.used, 300, '总量只含 chat');
        assert.equal(status.purposes.summarization.used, 500);
        assert.equal(status.session?.used, 300);
    },

    // ---------------- 第 4 组：判定边界 ----------------

    /** 粗闸：used == limit 即拒绝（>=） */
    testCheckChatUsedEqualsLimitRejects() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        QuotaManager.record('chat', 999, { sessionId: 'S1' });
        assert.equal(QuotaManager.checkChat({ sessionId: 'S1' }), null, '999 < 1000 放行');
        QuotaManager.record('chat', 1, { sessionId: 'S1' });
        const denial = QuotaManager.checkChat({ sessionId: 'S1' });
        assert.ok(denial, '1000 >= 1000 应拒绝');
        assert.equal(denial?.window, 'h');
        assert.equal(denial?.dimension, 'total');
        assert.equal(denial?.used, 1000);
        assert.equal(denial?.limit, 1000);
    },

    /** 细闸：要求 used + est < limit（严格小于），等于即拒绝 */
    testAdmitChatStrictLess() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        QuotaManager.record('chat', 400, { sessionId: 'S1' });
        // 400 + 599 = 999 < 1000 通过
        const ok = QuotaManager.admitChat({ sessionId: 'S1' }, 599);
        ok.release();
        // 400 + 600 = 1000 不 < 1000，拒绝
        assert.throws(
            () => QuotaManager.admitChat({ sessionId: 'S1' }, 600),
            (error: unknown) => {
                assert.ok(error instanceof QuotaExceededError);
                assert.equal(error.denial.dimension, 'total');
                return true;
            },
        );
    },

    /** 会话/个人维度各自独立触发，且维度归因正确 */
    testAdmitChatSessionUserDimensions() {
        setup(at(2026, 11, 5, 10, 0), {
            ENABLED: true,
            LIMIT_5H: 1000,
            SESSION_PERCENT: 50,
            USER_PERCENT: 20,
        });
        // 会话上限 500：S1 已用 450，再要 100 ⇒ 拒绝（维度 session）
        QuotaManager.record('chat', 450, { sessionId: 'S1', userId: 'U1' });
        assert.throws(
            () => QuotaManager.admitChat({ sessionId: 'S1', userId: 'U1' }, 100),
            (error: unknown) => {
                assert.ok(error instanceof QuotaExceededError);
                assert.equal(error.denial.dimension, 'session');
                assert.equal(error.denial.limit, 500);
                return true;
            },
        );
        // 个人上限 200：U1 已用 450 ⇒ 个人维度也先于总量命中（窗口内按 h→w→m 顺序、维度按 total→session→user）
        assert.throws(
            () => QuotaManager.admitChat({ sessionId: 'S2', userId: 'U1' }, 10),
            (error: unknown) => {
                assert.ok(error instanceof QuotaExceededError);
                assert.equal(error.denial.dimension, 'user');
                assert.equal(error.denial.limit, 200);
                return true;
            },
        );
    },

    /** 空身份：只受总量约束，不得写 users[''] / sessions[''] */
    testAdmitChatEmptyIdentitySkips() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000, SESSION_PERCENT: 10, USER_PERCENT: 10 });
        // 若写了空键，10% 的会话档（100）会立刻挡住 150 的请求
        QuotaManager.record('chat', 150);
        assert.equal(QuotaManager.checkChat({}), null, '空身份只受总量约束');
        const store = loadStore(clockNow);
        assert.equal(Object.keys(store.sessions).length, 0, '不应创建空会话键');
        assert.equal(Object.keys(store.users).length, 0, '不应创建空用户键');
    },

    /** 用途判定：单用途上限与全用途合计上限两条都要生效 */
    testAdmitPurposeSingleAndAggregate() {
        setup(at(2026, 11, 5, 10, 0), {
            ENABLED: true,
            LIMIT_5H: 1000,
            PURPOSE_PERCENT: {
                summarization: 50,
                judge: 50,
                'image-understanding': 100,
                'text-embedding': 100,
            },
        });
        // 摘要上限 500
        QuotaManager.record('summarization', 450);
        assert.throws(
            () => QuotaManager.admitPurpose('summarization', 100),
            (error: unknown) => {
                assert.ok(error instanceof QuotaExceededError);
                assert.equal(error.denial.dimension, 'purpose');
                assert.equal(error.denial.use, 'summarization');
                assert.equal(error.denial.limit, 500);
                return true;
            },
        );

        // 合计上限 1000：全部用途各 100% 额度，摘要 450 + 判定 450 = 900，再来 150 ⇒ 合计超限
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        QuotaManager.record('summarization', 450);
        QuotaManager.record('judge', 450);
        assert.throws(
            () => QuotaManager.admitPurpose('judge', 150),
            (error: unknown) => {
                assert.ok(error instanceof QuotaExceededError);
                assert.equal(error.denial.limit, 1000, '合计口径以总预算为准');
                assert.equal(error.denial.used, 900, 'used 是全部用途之和');
                return true;
            },
        );
        // 识图自身 0 已用、额度 1000，但合计已 900 ⇒ 同样被合计挡住
        assert.throws(() => QuotaManager.admitPurpose('image-understanding', 150), QuotaExceededError);
        // 合计仍有空间时放行
        assert.doesNotThrow(() => QuotaManager.admitPurpose('image-understanding', 99));
    },

    /** 媒体用途：既不检查也不记账 */
    testMediaUseSkipped() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        QuotaManager.record('tts', 500);
        QuotaManager.record('image-generation', 500);
        const status = QuotaManager.status();
        assert.equal(status.windows.h.used, 0, '媒体用途不记 total');
        assert.equal(Object.keys(status.purposes).length, 4);
        assert.equal(status.purposes.summarization.used, 0);
    },

    // ---------------- 第 5 组：预留状态机 ----------------

    /** 预留占额度、release 归还、重复 release 幂等 */
    testInflightReserveAndRelease() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000 });
        const handle = QuotaManager.admitChat({ sessionId: 'S1', userId: 'U1' }, 600);
        assert.deepEqual(QuotaManager.inflightSnapshotForTest(), { total: 600, sessions: 600, users: 600 });
        // 已预留 600，再要 500 会超（600+500 >= 1000）
        assert.throws(() => QuotaManager.admitChat({ sessionId: 'S1', userId: 'U1' }, 500), QuotaExceededError);
        handle.release();
        assert.deepEqual(QuotaManager.inflightSnapshotForTest(), { total: 0, sessions: 0, users: 0 });
        handle.release();
        assert.deepEqual(QuotaManager.inflightSnapshotForTest(), { total: 0, sessions: 0, users: 0 }, '重复 release 不得变负');
        const again = QuotaManager.admitChat({ sessionId: 'S1', userId: 'U1' }, 500);
        again.release();
    },

    /** record 不释放 inflight（结算与预留由调用方 finally 分开管） */
    testRecordDoesNotTouchInflight() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 10_000 });
        const handle = QuotaManager.admitChat({ sessionId: 'S1' }, 300);
        QuotaManager.record('chat', 280, { sessionId: 'S1' });
        assert.equal(QuotaManager.inflightSnapshotForTest().total, 300, 'record 不动 inflight');
        handle.release();
        assert.equal(QuotaManager.inflightSnapshotForTest().total, 0);
        assert.equal(QuotaManager.status({ sessionId: 'S1' }).windows.h.used, 280);
    },

    /** 跨窗口边界：旧预留仍占新窗口（保守），但不会永久泄漏 */
    testInflightAcrossWindowBoundary() {
        setup(at(2026, 11, 5, 14, 59), { ENABLED: true, LIMIT_5H: 1000 });
        const handle = QuotaManager.admitChat({ sessionId: 'S1' }, 900);
        clockNow = at(2026, 11, 5, 15, 1);
        // 新窗口 used=0，但 inflight 900 仍占用
        assert.equal(QuotaManager.status({ sessionId: 'S1' }).windows.h.used, 900, '跨窗口 inflight 保守占用');
        assert.throws(() => QuotaManager.admitChat({ sessionId: 'S1' }, 200), QuotaExceededError);
        handle.release();
        assert.equal(QuotaManager.status({ sessionId: 'S1' }).windows.h.used, 0);
    },

    /** estimateChat：校准后 prompt + 最多 4096 的 completion */
    testEstimateChatReserveCap() {
        setup(at(2026, 11, 5, 10, 0));
        assert.equal(QuotaManager.estimateChat('no-such-model', 1000, 100), 1100);
        assert.equal(
            QuotaManager.estimateChat('no-such-model', 1000, 65536),
            1000 + RESERVE_MAX_COMPLETION,
            'completion 预留最多 4096，不能吃满 max_tokens',
        );
        assert.equal(QuotaManager.estimateChat('no-such-model', 1000), 1000, 'max_tokens 缺省不预留');
    },

    // ---------------- 第 6 组：降级链路 ----------------

    /** 开关关闭：只统计不拦截（一键关停） */
    testDisabledOnlyRecords() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: false, LIMIT_5H: 10 });
        QuotaManager.record('chat', 999_999, { sessionId: 'S1', userId: 'U1' });
        assert.equal(QuotaManager.checkChat({ sessionId: 'S1', userId: 'U1' }), null, '关闭时不拦截');
        const handle = QuotaManager.admitChat({ sessionId: 'S1', userId: 'U1' }, 1_000_000);
        handle.release();
        assert.doesNotThrow(() => QuotaManager.admitPurpose('summarization', 1_000_000));
        assert.equal(QuotaManager.status({ sessionId: 'S1' }).windows.h.used, 999_999, '关闭时仍记账');
        assert.equal(QuotaManager.status().windows.h.limit, 10, '命令仍显示配置预算');
    },

    /** 存储损坏：坏 JSON / 版本不符 / 空串都退化为空 store 且不抛 */
    testStoreCorruptionDegrades() {
        for (const bad of ['', 'not-json', '{"version":2}', '[]']) {
            installHost(at(2026, 11, 5, 10, 0));
            resetStoreCacheForTest();
            storage.map.set(QUOTA_STORAGE_KEY, bad);
            const store = loadStore(clockNow);
            assert.equal(store.version, 1);
            assert.equal(store.total.h.v, 0);
            assert.equal(store.lastNow, clockNow);
        }
    },

    /** 31 天裁剪：空闲会话被丢弃，活跃会话保留 */
    testStoreTrimIdleEntries() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true });
        QuotaManager.record('chat', 100, { sessionId: 'OLD' });
        QuotaManager.flush(clockNow);
        // 40 天后：OLD 的 seen 已超 31 天
        const later = clockNow + 40 * 24 * 60 * 60 * 1000;
        clockNow = later;
        QuotaManager.record('chat', 100, { sessionId: 'NEW' });
        QuotaManager.flush(later);
        const store = loadStore(later);
        assert.ok(!Object.prototype.hasOwnProperty.call(store.sessions, 'OLD'), '空闲 31 天以上应被裁剪');
        assert.ok(Object.prototype.hasOwnProperty.call(store.sessions, 'NEW'));
    },

    /** reset：清空计数并在存储写空串（读侧当空 store） */
    testResetClearsStore() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true });
        QuotaManager.record('chat', 500, { sessionId: 'S1' });
        QuotaManager.flush(clockNow);
        assert.notEqual(storage.map.get(QUOTA_STORAGE_KEY), '');
        QuotaManager.reset();
        assert.equal(storage.map.get(QUOTA_STORAGE_KEY), '', 'reset 写空串');
        assert.equal(QuotaManager.status().windows.h.used, 0);
        assert.deepEqual(QuotaManager.inflightSnapshotForTest(), { total: 0, sessions: 0, users: 0 });
    },

    /** flush 仅在 dirty 时写；写入失败保留 dirty 供下次重试 */
    testFlushOnlyWhenDirtyAndRetries() {
        setup(at(2026, 11, 5, 10, 0));
        assert.equal(isDirty(), false);
        assert.equal(flushNow(clockNow), false, '无改动不写');
        QuotaManager.record('chat', 100, { sessionId: 'S1' });
        assert.equal(isDirty(), true);
        // 注入会抛的 set：模拟存储写失败
        const originalSet = getStorageSet();
        setFailingStorage(true);
        assert.equal(QuotaManager.flush(clockNow), false, '写失败返回 false');
        assert.equal(isDirty(), true, '写失败必须保留 dirty');
        setFailingStorage(false, originalSet);
        assert.equal(QuotaManager.flush(clockNow), true);
        assert.equal(isDirty(), false);
    },

    /** 手工设置 store 时，空 store 的构造函数语义（诊断用） */
    testEmptyStoreShape() {
        const store = emptyStore(1234);
        assert.equal(store.version, 1);
        assert.equal(store.lastNow, 1234);
        assert.deepEqual(store.sessions, {});
        assert.deepEqual(store.total.h, { k: '', v: 0 });
    },

    // ---------------- 第 7 组：提示节流 ----------------

    /** 同一 会话×窗口×维度 只提示一次；窗口切换后再次提示 */
    testNotifyOnceThrottleKey() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000, NOTIFY_ON_LIMIT: true });
        QuotaManager.record('chat', 1000, { sessionId: 'S1' });
        const denial = QuotaManager.checkChat({ sessionId: 'S1' });
        assert.ok(denial);
        assert.equal(QuotaManager.notifyOnce('S1', denial!), true, '首次应提示');
        assert.equal(QuotaManager.notifyOnce('S1', denial!), false, '同窗口同维度不重复提示');
        // 别的会话不受影响
        assert.equal(QuotaManager.notifyOnce('S2', denial!), true);
        // 维度不同 → 独立节流
        assert.equal(
            QuotaManager.notifyOnce('S1', { window: 'h', dimension: 'user', used: 1, limit: 1 }),
            true,
        );
        // 换窗口 → 重新提示
        clockNow = at(2026, 11, 5, 15, 0);
        assert.equal(QuotaManager.notifyOnce('S1', denial!), true, '新窗口应重新提示');
    },

    /** 「超限提示」关闭时一律不提示 */
    testNotifyOnceRespectsSwitch() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, NOTIFY_ON_LIMIT: false });
        const denial = { window: 'h' as const, dimension: 'total' as const, used: 1, limit: 1 };
        assert.equal(QuotaManager.notifyOnce('S1', denial), false);
        assert.equal(QuotaManager.notifyOnce('S1', denial), false);
    },

    /** 拒绝文案：窗口/维度/重置时刻都要正确，且不暴露 token 数字 */
    testFormatDenialText() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true });
        const total = QuotaManager.formatDenialText({ window: 'h', dimension: 'total', used: 100, limit: 100 });
        assert.match(total, /5小时/);
        assert.match(total, /15:00/);
        assert.ok(!/\d{4,}/.test(total.replace(/5小时/g, '')), '提示不得暴露具体 token 数');

        const user = QuotaManager.formatDenialText({ window: 'w', dimension: 'user', used: 1, limit: 1 });
        assert.match(user, /本周的 AI 用量已达上限/);

        const purpose = QuotaManager.formatDenialText({
            window: 'm',
            dimension: 'purpose',
            use: 'judge',
            used: 1,
            limit: 1,
        });
        assert.match(purpose, /judge/);
    },

    // ---------------- 第 8 组：链路与契约 ----------------

    /** record 永不抛：坏参数、媒体用途、未知用途都只静默返回 */
    testRecordNeverThrows() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true });
        assert.doesNotThrow(() => QuotaManager.record('chat', Number.NaN));
        assert.doesNotThrow(() => QuotaManager.record('chat', -5));
        assert.doesNotThrow(() => QuotaManager.record('unknown-use', 100));
        assert.doesNotThrow(() => QuotaManager.record('tts', 100));
        assert.equal(QuotaManager.status().windows.h.used, 0);
    },

    /** 配置读取器抛错时按默认值（关闭）处理，不能把插件拖死 */
    testBrokenConfigReaderDegrades() {
        setup(at(2026, 11, 5, 10, 0));
        QuotaManager.configure(() => { throw new Error('boom'); });
        assert.equal(QuotaManager.checkChat({ sessionId: 'S1' }), null, '读配置失败应放行');
        assert.doesNotThrow(() => QuotaManager.record('chat', 100, { sessionId: 'S1' }));
        assert.equal(QuotaManager.status().enabled, false);
    },

    /** QuotaExceededError 契约：不是 ApiError、带 denial、message 是结构化短串 */
    testQuotaExceededErrorContract() {
        const error = new QuotaExceededError({ window: 'h', dimension: 'session', used: 10, limit: 10 });
        assert.equal(error.name, 'QuotaExceededError');
        assert.ok(error instanceof Error);
        assert.equal(error.denial.dimension, 'session');
        assert.equal(error.window, 'h');
        assert.equal(error.dimension, 'session');
        assert.match(error.message, /quota exceeded/);
        // 故意不继承 ApiError：类型层面也不应有 apiError 字段
        assert.equal((error as unknown as { apiError?: unknown }).apiError, undefined);
    },

    /** status 的 peakSegment：命中给原文，未命中给 null */
    testStatusPeakSegmentBothStates() {
        const rule = parsePeakTemplate(['1-5 09:00-12:00-30']);
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, PEAK_RULE: rule });
        assert.equal(QuotaManager.status().peakSegment, '1-5 09:00-12:00-30');
        assert.equal(QuotaManager.status().peakPercent, 0.3);
        clockNow = at(2026, 11, 5, 13, 0);
        assert.equal(QuotaManager.status().peakSegment, null);
        assert.equal(QuotaManager.status().peakPercent, 1);
    },

    /** rank：按用量降序；不限时 percent === null（不是 0、不是 NaN） */
    testRankPercentNullWhenUnlimited() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 0 });
        QuotaManager.record('chat', 300, { sessionId: 'S1' });
        QuotaManager.record('chat', 900, { sessionId: 'S2' });
        QuotaManager.record('chat', 100, { sessionId: 'S3' });
        const rows = QuotaManager.rank('h', 10);
        assert.deepEqual(rows.map(r => r.sessionId), ['S2', 'S1', 'S3'], '按用量降序');
        assert.ok(rows.every(r => r.percent === null), '不限时 percent 必须是 null');

        useView({ ENABLED: true, LIMIT_5H: 1000 });
        const limited = QuotaManager.rank('h', 2);
        assert.equal(limited.length, 2, 'limit 生效');
        assert.equal(limited[0].percent, 90, '900/1000');
    },

    /** meWindows：三窗口齐全，且与 status().windows 同值 */
    testMeWindowsMatchesStatus() {
        setup(at(2026, 11, 5, 10, 0), { ENABLED: true, LIMIT_5H: 1000, USER_PERCENT: 50 });
        QuotaManager.record('chat', 100, { sessionId: 'S1', userId: 'U1' });
        const mine = QuotaManager.meWindows('U1');
        const status = QuotaManager.status({ userId: 'U1' });
        assert.deepEqual(Object.keys(mine).sort(), ['h', 'm', 'w']);
        for (const window of ['h', 'w', 'm'] as const) {
            assert.equal(mine[window].used, status.windows[window].used, `${window} 已用应一致`);
            assert.equal(mine[window].limit, Math.floor(status.windows[window].limit * 0.5));
        }
        // 无 userId：全是 0，不造空键
        assert.equal(QuotaManager.meWindows('').h.used, 0);
    },

    /** 重置时刻：5h 给下一个 5 小时边界，周给下周一，月给下月 1 日 */
    testNextResetAtAllWindows() {
        setup(at(2026, 11, 5, 10, 0));
        assert.equal(nextResetAt('h', clockNow), at(2026, 11, 5, 15, 0));
        assert.equal(nextResetAt('w', clockNow), at(2026, 11, 9, 0, 0));
        assert.equal(nextResetAt('m', clockNow), at(2026, 12, 1, 0, 0));
    },

    /** expandPeakSegments：跨 0 点拍平后每条 end 都 > start（半开区间可直判） */
    testExpandPeakSegmentsFlattens() {
        const segments = expandPeakSegments([1], 1320, 120, 30, 1, 'raw');
        assert.equal(segments.length, 2);
        assert.deepEqual(segments[0], { day: 1, start: 1320, end: 1440, pct: 30, frame: 1, raw: 'raw' });
        assert.deepEqual(segments[1], { day: 2, start: 0, end: 120, pct: 30, frame: 1, raw: 'raw' });
        assert.ok(segments.every(s => s.end > s.start));
    },

    /** isoDayOf / minuteOfDayOf 的边界 */
    testIsoDayAndMinuteOfDay() {
        setup(at(2026, 11, 8, 0, 0)); // 周日
        assert.equal(isoDayOf(clockNow), 7);
        assert.equal(minuteOfDayOf(clockNow), 0);
        clockNow = at(2026, 11, 9, 23, 59);
        assert.equal(isoDayOf(clockNow), 1);
        assert.equal(minuteOfDayOf(clockNow), 23 * 60 + 59);
    },

    /** 手动 resetStore + loadStore 的一致性（不依赖 manager） */
    testResetStoreRoundTrip() {
        installHost(at(2026, 11, 5, 10, 0));
        resetStoreCacheForTest();
        resetStore(clockNow);
        assert.equal(storage.map.get(QUOTA_STORAGE_KEY), '');
        const store = loadStore(clockNow);
        assert.equal(store.version, 1);
        assert.equal(store.total.h.v, 0);
    },

    /** 配置页形状：12 键、顺序固定、默认模板与 get() 兜底 */
    testConfigRegisterShape() {
        assert.equal(QUOTA_CONFIG_KEYS.length, 12, '配置键必须是 12 个');
        assert.deepEqual(
            [...QUOTA_CONFIG_KEYS],
            [
                '启用用量限制',
                '5小时限制',
                '一周限制',
                '一个月限制',
                '会话限制百分比',
                '个人限制百分比',
                '限制时段及百分比',
                '摘要用途百分比',
                '判定用途百分比',
                '识图用途百分比',
                '嵌入用途百分比',
                '超限提示',
            ],
            '配置页顺序即用户阅读顺序，不能随意调换',
        );
        // register() 走 seal 桩不应抛，且模板默认值被登记
        assert.doesNotThrow(() => QuotaConfig.register());
        const TC = (globalThis as unknown as { __TEST_CONFIG__?: { factoryTemplateConfigs: Record<string, string[]> } }).__TEST_CONFIG__;
        assert.deepEqual(TC?.factoryTemplateConfigs['限制时段及百分比'], [...DEFAULT_PEAK_TEMPLATE]);

        // get() 在桩默认值下也不抛，且字段齐全
        const parsed = QuotaConfig.get();
        assert.deepEqual(Object.keys(parsed).sort(), [
            'ENABLED',
            'LIMIT_5H',
            'LIMIT_MONTH',
            'LIMIT_WEEK',
            'NOTIFY_ON_LIMIT',
            'PEAK_RULE',
            'PURPOSE_PERCENT',
            'SESSION_PERCENT',
            'USER_PERCENT',
        ].sort());
        assert.equal(parsed.ENABLED, true, 'seal 桩的 getBoolConfig 默认 true');
        assert.equal(parsed.LIMIT_5H, 0, 'seal 桩的 getIntConfig 默认 0');
    },
};

// ---- flush 写失败的注入辅助（放在文件末尾，避免打断 tests 字面量可读性） ----

let failing = false;

function getStorageSet(): (key: string, value: string) => void {
    return (key: string, value: string) => storage.set(key, value);
}

function setFailingStorage(on: boolean, restore?: (key: string, value: string) => void): void {
    failing = on;
    if (!on && restore) {
        setHost({
            storage: {
                get: (key: string) => storage.get(key),
                set: restore,
            },
            clock: { now: () => clockNow },
            fetch: (() => { throw new Error('no fetch in quota tests'); }) as never,
            ext: {} as never,
        });
        return;
    }
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => {
                if (failing) throw new Error('storage write failed');
                storage.set(key, value);
            },
        },
        clock: { now: () => clockNow },
        fetch: (() => { throw new Error('no fetch in quota tests'); }) as never,
        ext: {} as never,
    });
}
