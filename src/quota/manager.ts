// 用量限制内核（L2 能力层）：判定、预留、记账、节流提示、渲染数据源。
//
// 硬约束（.dev/issue-59-requirements.md §6 + 决策 D8/D10）：
// - **判定集中在本文件的 `limitOf`**：调用点不得各写一份公式（P0 §5 完成判定要求）；
// - `record` **永不抛**：它跑在模型请求成功之后，抛错会被 provider 当成失败并重试已成功的请求（重复计费）；
// - `release()` 幂等且永不抛：漏释放会让该会话之后的所有请求被自己的预留挡住；
// - `ENABLED === false` 时只记账、`checkChat`/`admitChat` 一律放行（降级为一键关停开关）。
import type { QuotaConfigView } from '../config/configs/quota';
import { getHost } from '../core/host';
import { logger } from '../logger';
import { isMediaUse } from '../model/types';
import { TokenCalibration } from '../token_calibration';

import { counterOf, ensureDimEntry, flushNow, loadStore, markDirty, resetStore, scheduleFlush, setCounter } from './store';
import { QuotaExceededError } from './types';
import type {
    QuotaDenial,
    QuotaDimension,
    QuotaIdentity,
    QuotaPurposeUse,
    QuotaRankRow,
    QuotaReserveHandle,
    QuotaStatus,
    WinCounter,
    WindowKey,
} from './types';
import { nextResetAt, peakPercentAt, windowKeyOf } from './window';

/** 预留的 completion 上限（token）：估算输出量时最多预留这么多，**不用 65536**（会把小请求全判死） */
export const RESERVE_MAX_COMPLETION = 4096;

/** 判定窗口优先级：先看最短窗口（越短越容易被撞到，提示也更可操作） */
const WINDOWS: readonly WindowKey[] = ['h', 'w', 'm'];

/** 四个受配额约束的语言用途 */
const PURPOSES: readonly QuotaPurposeUse[] = ['summarization', 'judge', 'image-understanding', 'text-embedding'];

/** 窗口中文名（提示文案用） */
const WINDOW_LABEL: Record<WindowKey, string> = { h: '5小时', w: '本周', m: '本月' };

/** 个人维度的时态词（提示文案用） */
const USER_LABEL: Record<WindowKey, string> = { h: '今天', w: '本周', m: '本月' };

function defaultView(): QuotaConfigView {
    return {
        ENABLED: false,
        LIMIT_5H: 0,
        LIMIT_WEEK: 0,
        LIMIT_MONTH: 0,
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
    };
}

/** 在飞预留：三维各一个标量（不按窗口键拆分，跨窗口边界时保守占用新窗口） */
interface Inflight {
    total: number;
    sessions: Map<string, number>;
    users: Map<string, number>;
}

function emptyInflight(): Inflight {
    return { total: 0, sessions: new Map(), users: new Map() };
}

function readMap(map: Map<string, number>, key: string): number {
    return map.get(key) ?? 0;
}

function addMap(map: Map<string, number>, key: string, delta: number): void {
    const next = Math.max(0, readMap(map, key) + delta);
    if (next === 0) map.delete(key);
    else map.set(key, next);
}

function pad2(n: number): string {
    return n < 10 ? '0' + n : String(n);
}

/** 重置时刻的短格式：5 小时窗口给 `HH:mm`，周/月给 `MM-dd HH:mm` */
function formatResetAt(window: WindowKey, at: number): string {
    const d = new Date(at);
    if (window === 'h') return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isPurposeUse(use: string): use is QuotaPurposeUse {
    return (PURPOSES as readonly string[]).includes(use);
}

type Reader = () => QuotaConfigView;

export class QuotaManager {
    private static reader: Reader | null = null;
    private static inflight: Inflight = emptyInflight();
    /** 节流表：`sid|窗口键|维度` → 已提示过的窗口键（窗口键变化即自动放行） */
    private static notified: Map<string, string> = new Map();
    /** 时钟回拨告警去重：记录已告警的 lastNow，避免每个请求刷一条 warning */
    private static rollbackWarnedAt = 0;

    /**
     * 注入配置读取器（组合根/测试调用一次）。
     *
     * @param read 返回当前配置视图；内部缓存 60s 由 `Config.quota` 的 TTL 保证，这里不重复缓存
     */
    static configure(read: Reader): void {
        this.reader = read;
    }

    /** 未注入读取器时用默认值 */
    private static view(): QuotaConfigView {
        if (!this.reader) return defaultView();
        try {
            return this.reader();
        } catch (error) {
            logger.warning(`读取用量限制配置失败，本次按默认值处理：${error instanceof Error ? error.message : String(error)}`);
            return defaultView();
        }
    }

    /** 宿主时钟（单测可注入假时钟）；HostSeam 未初始化时退回系统时间，避免早期调用炸掉 */
    private static nowRaw(): number {
        try {
            return getHost().clock.now();
        } catch {
            return this.nowRaw();
        }
    }

    /** 注入的读取器是否可用（命令层用它区分「配置未注册」） */
    static isConfigured(): boolean {
        return this.reader !== null;
    }

    /**
     * 有效「当前时刻」：时钟回拨时钉在 `lastNow`。
     *
     * 回拨会让窗口键倒退，若照常比对就会把计数当 0（用户白拿额度）。这里不退让：
     * 继续用 lastNow 的键，计数原样保留，直到真实时间追上来。
     */
    private static effectiveNow(now: number): number {
        const store = loadStore(now);
        if (now < store.lastNow) {
            if (this.rollbackWarnedAt !== store.lastNow) {
                this.rollbackWarnedAt = store.lastNow;
                logger.warning(
                    `检测到系统时间回拨（当前 ${new Date(now).toLocaleString()} < 记录 ${new Date(store.lastNow).toLocaleString()}），`
                    + '用量窗口暂不重置，计数保持不变',
                );
            }
            return store.lastNow;
        }
        return now;
    }

    /** 当前预算系数（0..1）：命中峰时片段则取该片段的百分比 */
    private static coefficientOf(view: QuotaConfigView, now: number): { coefficient: number; raw: string | null } {
        const hit = peakPercentAt(view.PEAK_RULE, now);
        return { coefficient: hit.pct / 100, raw: hit.segment ? hit.segment.raw : null };
    }

    /** 某窗口的基础限制（配置值，0 = 不限） */
    private static baseLimitOf(view: QuotaConfigView, window: WindowKey): number {
        if (window === 'h') return view.LIMIT_5H;
        if (window === 'w') return view.LIMIT_WEEK;
        return view.LIMIT_MONTH;
    }

    /**
     * 有效总预算 `E_X = (B_X === 0) ? ∞ : max(1, floor(B_X × p))`。
     *
     * **`0=不限` 必须按 `B_X` 判**：先乘系数再判 0 会把 `B=1, p=30%` 误当不限。
     */
    private static limitOf(view: QuotaConfigView, window: WindowKey, coefficient: number): number {
        const base = this.baseLimitOf(view, window);
        if (base === 0) return Infinity;
        return Math.max(1, Math.floor(base * coefficient));
    }

    /** 会话维度的上限 */
    private static sessionLimitOf(total: number, percent: number): number {
        if (!Number.isFinite(total)) return Infinity;
        return Math.max(1, Math.floor(total * percent / 100));
    }

    /** 用途维度的上限（按百分比切总预算） */
    private static purposeLimitOf(total: number, percent: number): number {
        if (!Number.isFinite(total)) return Infinity;
        return Math.max(1, Math.floor(total * percent / 100));
    }

    /** 某维度的已用量（窗口键不符视为 0） */
    private static usedOf(entry: WinCounter | undefined, window: WindowKey, key: string): number {
        if (!entry) return 0;
        return counterOf(entry, window, key);
    }

    /**
     * 判定核心：返回首个命中（窗口 → 维度），未超限返回 null。
     *
     * @param est 本次预估；粗闸传 0，细闸传估算值
     * @param strict `true` = 细闸语义（要求 `used + inflight + est < limit` 才通过），
     *               `false` = 粗闸语义（`used + inflight >= limit` 即拒绝）
     */
    private static evaluate(
        identity: QuotaIdentity,
        est: number,
        strict: boolean,
    ): QuotaDenial | null {
        const view = this.view();
        // 一键关停：关闭时任何判定都放行（只记账不拦截）
        if (!view.ENABLED) return null;
        const raw = this.nowRaw();
        const now = this.effectiveNow(raw);
        const store = loadStore(now);
        const { coefficient } = this.coefficientOf(view, now);
        const sid = identity.sessionId || '';
        const uid = identity.userId || '';

        for (const window of WINDOWS) {
            const key = windowKeyOf(window, now);
            const total = this.limitOf(view, window, coefficient);
            const totalUsed = this.usedOf(store.total, window, key) + this.inflight.total;
            if (this.exceeds(totalUsed, est, total, strict)) {
                return { window, dimension: 'total', used: totalUsed, limit: total };
            }
            if (sid) {
                const limit = this.sessionLimitOf(total, view.SESSION_PERCENT);
                const used = this.usedOf(store.sessions[sid], window, key) + readMap(this.inflight.sessions, sid);
                if (this.exceeds(used, est, limit, strict)) {
                    return { window, dimension: 'session', used, limit };
                }
            }
            if (uid) {
                const limit = this.sessionLimitOf(total, view.USER_PERCENT);
                const used = this.usedOf(store.users[uid], window, key) + readMap(this.inflight.users, uid);
                if (this.exceeds(used, est, limit, strict)) {
                    return { window, dimension: 'user', used, limit };
                }
            }
        }
        return null;
    }

    /** 粗闸：`used + inflight >= limit` 即拒绝；细闸：`used + inflight + est >= limit` 即拒绝 */
    private static exceeds(used: number, est: number, limit: number, strict: boolean): boolean {
        if (!Number.isFinite(limit)) return false;
        return strict ? used + est >= limit : used >= limit;
    }

    /**
     * 起轮粗闸（不估算本次请求）：只读，不预留。
     *
     * @returns 拒绝原因（调用点据此渲染提示/返回 `'quota'`）；`null` = 放行
     */
    static checkChat(identity: QuotaIdentity = {}): QuotaDenial | null {
        try {
            return this.evaluate(identity, 0, false);
        } catch (error) {
            logger.warning(`用量粗筛异常，已放行：${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /** 该会话/用户当前是否已被拒（命令与 P2 用；与 checkChat 同一判定，不复制公式） */
    static isBlocked(identity: QuotaIdentity = {}): boolean {
        return this.checkChat(identity) !== null;
    }

    /**
     * 请求级细闸 + 预留。
     *
     * @throws QuotaExceededError 超限时抛（**不继承 ApiError**，见 types.ts 注释）
     */
    static admitChat(identity: QuotaIdentity, est: number): QuotaReserveHandle {
        const denial = this.evaluate(identity, Math.max(0, Math.ceil(est)), true);
        if (denial) throw new QuotaExceededError(denial);

        const reserve = Math.max(0, Math.ceil(est));
        const sid = identity.sessionId || '';
        const uid = identity.userId || '';
        this.inflight.total += reserve;
        if (sid) addMap(this.inflight.sessions, sid, reserve);
        if (uid) addMap(this.inflight.users, uid, reserve);

        let released = false;
        return {
            est: reserve,
            release: () => {
                if (released) return;
                released = true;
                this.inflight.total = Math.max(0, this.inflight.total - reserve);
                if (sid) addMap(this.inflight.sessions, sid, -reserve);
                if (uid) addMap(this.inflight.users, uid, -reserve);
            },
        };
    }

    /**
     * 用途细闸（无预留）。
     *
     * 两个条件同时满足才通过：单用途预算、全用途合计预算（`Σ_j` **逐窗口**求和）。
     *
     * @throws QuotaExceededError
     */
    static admitPurpose(use: QuotaPurposeUse, est: number): void {
        const view = this.view();
        if (!view.ENABLED) return;
        const now = this.effectiveNow(this.nowRaw());
        const store = loadStore(now);
        const { coefficient } = this.coefficientOf(view, now);
        const need = Math.max(0, Math.ceil(est));
        const percent = view.PURPOSE_PERCENT[use] ?? 100;

        for (const window of WINDOWS) {
            const key = windowKeyOf(window, now);
            const total = this.limitOf(view, window, coefficient);
            if (!Number.isFinite(total)) continue;
            const ownLimit = this.purposeLimitOf(total, percent);
            const ownUsed = this.usedOf(store.purposes[use], window, key);
            if (ownUsed + need >= ownLimit) {
                throw new QuotaExceededError({ window, dimension: 'purpose', use, used: ownUsed, limit: ownLimit });
            }
            let sum = 0;
            for (const other of PURPOSES) sum += this.usedOf(store.purposes[other], window, key);
            if (sum + need >= total) {
                throw new QuotaExceededError({ window, dimension: 'purpose', use, used: sum, limit: total });
            }
        }
    }

    /**
     * 记一次真实用量。
     *
     * @param use 模型用途（`chat` / 四个语言用途 / 媒体用途）
     * @param totalTokens `prompt_tokens + completion_tokens`（缓存 token 按 100% 计，不做价格换算）
     * @param identity 归属；外部 API `chat`/`chatMessages` 不传（只记 total）
     *
     * **永不抛**：内部整体 try/catch，异常只 warning。抛错会被 provider 当成请求失败并重试。
     */
    static record(use: string, totalTokens: number, identity: QuotaIdentity = {}): void {
        try {
            if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
            if (isMediaUse(use)) return;
            const isChat = use === 'chat';
            if (!isChat && !isPurposeUse(use)) return;

            const now = this.effectiveNow(this.nowRaw());
            const store = loadStore(now);
            store.lastNow = Math.max(store.lastNow, now);

            const apply = (entry: WinCounter, name: string): void => {
                for (const window of WINDOWS) {
                    const key = windowKeyOf(window, now);
                    const current = counterOf(entry, window, key);
                    setCounter(entry, window, key, current + totalTokens);
                }
                void name;
            };

            if (isChat) {
                // 只有对话计入总量；辅助用途单独记 purposes（否则用途会吃掉对话额度）
                for (const window of WINDOWS) {
                    const key = windowKeyOf(window, now);
                    setCounter(store.total, window, key, counterOf(store.total, window, key) + totalTokens);
                }
                const sid = identity.sessionId || '';
                if (sid) apply(ensureDimEntry(store.sessions, sid, now), sid);
                const uid = identity.userId || '';
                // 合成上下文（定时器/事件/子代理唤醒）没有触发者：不得写 users[''] 之类的空键
                if (uid) apply(ensureDimEntry(store.users, uid, now), uid);
            } else {
                apply(ensureDimEntry(store.purposes, use, now), use);
            }

            markDirty();
            scheduleFlush(() => this.view().ENABLED);
        } catch (error) {
            logger.warning(`用量记账失败（已忽略，不影响本次请求）：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 节流提示闸门：同一「会话 × 窗口 × 维度」在同一窗口内最多提示一次。
     *
     * @returns `true` = 应该向用户发提示；`false` = 已提示过或「超限提示」被关闭
     */
    static notifyOnce(sessionId: string, denial: QuotaDenial): boolean {
        const view = this.view();
        if (!view.NOTIFY_ON_LIMIT) return false;
        const now = this.effectiveNow(this.nowRaw());
        const windowKey = windowKeyOf(denial.window, now);
        const dimension = denial.dimension === 'purpose' && denial.use ? `purpose:${denial.use}` : denial.dimension;
        const key = `${sessionId || ''}|${denial.window}|${dimension}`;
        if (this.notified.get(key) === windowKey) return false;
        this.notified.set(key, windowKey);
        // 表可能随会话数无限增长：超过阈值时清掉已过窗口的键
        if (this.notified.size > 4096) {
            for (const [name, seen] of this.notified) {
                const window = denial.window;
                if (seen !== windowKey) this.notified.delete(name);
                else void window;
            }
        }
        return true;
    }

    /** 拒绝文案（纯函数，无副作用；`limit === Infinity` 不会走到这里，但保留兜底） */
    static formatDenialText(denial: QuotaDenial): string {
        const now = this.effectiveNow(this.nowRaw());
        const reset = formatResetAt(denial.window, nextResetAt(denial.window, now));
        if (denial.dimension === 'user') {
            return `你${USER_LABEL[denial.window]}的 AI 用量已达上限，预计 ${reset} 重置。`;
        }
        if (denial.dimension === 'purpose') {
            return `AI 辅助用途「${denial.use ?? '未知'}」用量已达上限，预计 ${reset} 重置。`;
        }
        return `AI 用量已达上限（${WINDOW_LABEL[denial.window]}对话额度），预计 ${reset} 重置，请稍后再试。`;
    }

    /** 估算一次 chat 请求：校准后的 prompt + 最多 4096 的 completion 预留 */
    static estimateChat(modelName: string, rawEstimate: number, maxTokens?: number): number {
        const prompt = TokenCalibration.predict(modelName, Math.max(0, rawEstimate));
        const completion = Math.min(Math.max(0, Math.floor(maxTokens ?? 0)), RESERVE_MAX_COMPLETION);
        return Math.max(0, prompt) + completion;
    }

    /** 估算一次辅助用途请求：只估 prompt（用途侧不预留 completion） */
    static estimatePurpose(use: QuotaPurposeUse, rawEstimate: number): number {
        void use;
        return Math.max(0, Math.ceil(TokenCalibration.predict('', Math.max(0, rawEstimate))));
    }

    /** 三窗口快照（`.ai tk quota` / `.ai tk me` 的数据源；只读） */
    static status(identity: QuotaIdentity = {}): QuotaStatus {
        const view = this.view();
        const now = this.effectiveNow(this.nowRaw());
        const store = loadStore(now);
        const { coefficient, raw } = this.coefficientOf(view, now);
        const sid = identity.sessionId || '';
        const uid = identity.userId || '';

        const windows = {} as QuotaStatus['windows'];
        for (const window of WINDOWS) {
            const key = windowKeyOf(window, now);
            const limit = this.limitOf(view, window, coefficient);
            const used = this.usedOf(store.total, window, key) + (view.ENABLED ? this.inflight.total : 0);
            windows[window] = { key, used, limit, resetAt: nextResetAt(window, now) };
        }

        const purposes: QuotaStatus['purposes'] = {};
        const hourLimit = windows.h.limit;
        const hourKey = windows.h.key;
        for (const use of PURPOSES) {
            purposes[use] = {
                used: this.usedOf(store.purposes[use], 'h', hourKey),
                limit: this.purposeLimitOf(hourLimit, view.PURPOSE_PERCENT[use] ?? 100),
            };
        }

        const status: QuotaStatus = {
            enabled: view.ENABLED,
            now,
            peakPercent: coefficient,
            peakSegment: raw,
            windows,
            purposes,
        };
        if (sid) {
            status.session = {
                used: this.usedOf(store.sessions[sid], 'h', hourKey),
                limit: this.sessionLimitOf(hourLimit, view.SESSION_PERCENT),
            };
        }
        if (uid) {
            status.user = {
                used: this.usedOf(store.users[uid], 'h', hourKey),
                limit: this.sessionLimitOf(hourLimit, view.USER_PERCENT),
            };
        }
        return status;
    }

    /** 个人三窗口（`.ai tk me`）：与 `status().windows` 同源，不复制判定式 */
    static meWindows(userId: string): Record<WindowKey, { used: number; limit: number }> {
        const view = this.view();
        const now = this.effectiveNow(this.nowRaw());
        const store = loadStore(now);
        const { coefficient } = this.coefficientOf(view, now);
        const out = {} as Record<WindowKey, { used: number; limit: number }>;
        for (const window of WINDOWS) {
            const key = windowKeyOf(window, now);
            const total = this.limitOf(view, window, coefficient);
            out[window] = {
                used: userId ? this.usedOf(store.users[userId], window, key) : 0,
                limit: this.sessionLimitOf(total, view.USER_PERCENT),
            };
        }
        return out;
    }

    /** 会话排行（`.ai tk rank`）：按指定窗口用量降序；`percent` 在不限时为 `null` */
    static rank(window: WindowKey, limit: number): QuotaRankRow[] {
        const view = this.view();
        const now = this.effectiveNow(this.nowRaw());
        const store = loadStore(now);
        const { coefficient } = this.coefficientOf(view, now);
        const key = windowKeyOf(window, now);
        const total = this.limitOf(view, window, coefficient);
        const sessionLimit = this.sessionLimitOf(total, view.SESSION_PERCENT);

        const rows: QuotaRankRow[] = [];
        for (const [sessionId, entry] of Object.entries(store.sessions)) {
            const used = this.usedOf(entry, window, key);
            if (used <= 0) continue;
            rows.push({
                sessionId,
                used,
                percent: Number.isFinite(sessionLimit) ? Math.round(used / sessionLimit * 100) : null,
            });
        }
        rows.sort((a, b) => b.used - a.used || a.sessionId.localeCompare(b.sessionId));
        return rows.slice(0, Math.max(1, Math.floor(limit)));
    }

    /** 清空全部计数（`.ai tk quota clear`）：清存储 + 清零在飞预留与节流表 */
    static reset(): void {
        const now = this.nowRaw();
        resetStore(now);
        this.inflight = emptyInflight();
        this.notified.clear();
        this.rollbackWarnedAt = 0;
    }

    /** 立即落盘（进程退出/测试用；正常路径由 scheduleFlush 合并写） */
    static flush(now: number = this.nowRaw()): boolean {
        return flushNow(now);
    }

    /** 测试专用：清空在飞预留（模拟进程重启） */
    static releaseAllInflightForTest(): void {
        this.inflight = emptyInflight();
    }

    /** 测试专用：读取当前在飞总量（断言释放闭合用） */
    static inflightSnapshotForTest(): { total: number; sessions: number; users: number } {
        return {
            total: this.inflight.total,
            sessions: [...this.inflight.sessions.values()].reduce((sum, value) => sum + value, 0),
            users: [...this.inflight.users.values()].reduce((sum, value) => sum + value, 0),
        };
    }

    /** 测试专用：清空节流表 */
    static clearNotifiedForTest(): void {
        this.notified.clear();
    }

    /** 类型收窄辅助：把任意维度名转成受支持维度（P1 日志用） */
    static dimensionName(dimension: QuotaDimension): string {
        return dimension;
    }
}
