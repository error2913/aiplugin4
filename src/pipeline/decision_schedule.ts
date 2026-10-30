// 判定入口调度（L4，内存瞬时语义）：消息去抖、静默探针、在飞标记。
//
// 方案 §6.4/C5：这三类语义**不进 timerQueue**（避免 5s 轮询污染），重载即丢（文档化）。
// M3 只提供实现与默认关闭的探针；接线与治理（去抖生效/在飞/pending 合并）属 R2。
import { logger } from "../logger";
import type { Session } from "../session/session";

const log = logger.withTag('decision-schedule');

/** 判定触发源（日志/观测用；三类入口共用同一判定内核） */
export type DecisionSource = 'message' | 'wait' | 'probe';

export interface DecisionCandidate {
    session: Session;
    ctx: seal.MsgContext;
    msg: seal.Message;
    text: string;
    /** 入队时间（毫秒） */
    at: number;
    /** 触发源：消息去抖 / WAIT 轮末 / 静默探针 */
    source?: DecisionSource;
    /** 是否 @/点名了 bot（去抖旁路、IGNORE 冷却旁路用） */
    addressed?: boolean;
    /** 发送者 UNI-ID（特征层 Friendships/交替率用） */
    senderId?: string;
}

export interface DecisionDueHandler {
    (candidate: DecisionCandidate): Promise<void>;
}

interface PendingCandidate extends DecisionCandidate {
    timer: unknown;
    deadline: number;
    /** 连续消息数：延迟按 2^n 增长、封顶 debounce_max_sec */
    consecutive: number;
}

/** scheduleMessage 的去抖参数（来自 [gate] debounce_sec / debounce_max_sec） */
export interface DebounceConfig {
    /** 基础去抖毫秒 */
    debounceMs: number;
    /** 封顶毫秒 */
    maxMs: number;
    /** Addressed/强 Help 跳过去抖（仍异步，避免同步重入调用方） */
    bypass?: boolean;
}

interface ProbeState {
    nextAt: number;
    /** 当前探测间隔（秒），按 backoff 倍率增长、封顶 maxGapSec */
    gapSec: number;
}

export interface DecisionScheduler {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const defaultScheduler: DecisionScheduler = {
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DecisionSchedule {
    private pending = new Map<string, PendingCandidate>();
    private inflight = new Set<string>();
    /** 在飞期间到达的最新候选（合并，不排队叠加；在飞结束后立即补跑一次） */
    private queued = new Map<string, DecisionCandidate>();
    private probes = new Map<string, ProbeState>();
    private readonly scheduler: DecisionScheduler;
    private readonly now: () => number;
    private onDue: DecisionDueHandler | null = null;

    constructor(options: { scheduler?: DecisionScheduler; now?: () => number } = {}) {
        this.scheduler = options.scheduler || defaultScheduler;
        this.now = options.now || (() => Date.now());
    }

    /** 装配回调：到期后真正进入判定（由 judge_manager 提供） */
    setHandler(handler: DecisionDueHandler | null): void {
        this.onDue = handler;
    }

    /** 消息去抖（固定延迟；兼容/单测用，生产走 scheduleMessage） */
    schedule(candidate: Omit<DecisionCandidate, 'at'>, debounceMs: number): void {
        const sid = candidate.session.sessionId;
        this.cancel(sid);
        const timer = this.scheduler.setTimeout(() => {
            this.pending.delete(sid);
            this.dispatch({ ...candidate, at: this.now(), source: candidate.source || 'message' });
        }, Math.max(1, debounceMs));
        this.pending.set(sid, { ...candidate, at: this.now(), timer, deadline: this.now() + debounceMs, consecutive: 0 });
    }

    /**
     * 消息去抖（R2 治理）：同会话新消息覆盖旧候选，延迟按连续消息数翻倍并封顶 maxMs；
     * Addressed/强 Help 旁路（bypass=true ⇒ 0ms 立即评估）。
     */
    scheduleMessage(candidate: Omit<DecisionCandidate, 'at'>, cfg: DebounceConfig): void {
        const sid = candidate.session.sessionId;
        const prev = this.pending.get(sid);
        const consecutive = prev ? prev.consecutive + 1 : 0;
        const base = Math.max(0, cfg.debounceMs);
        const cap = Math.max(base, cfg.maxMs);
        const delay = cfg.bypass ? 0 : Math.min(cap, base * Math.pow(2, Math.min(consecutive, 16)));
        if (prev) this.scheduler.clearTimeout(prev.timer);
        const timer = this.scheduler.setTimeout(() => {
            this.pending.delete(sid);
            this.dispatch({ ...candidate, at: this.now(), source: candidate.source || 'message' });
        }, Math.max(1, delay));
        this.pending.set(sid, {
            ...candidate,
            at: this.now(),
            timer,
            deadline: this.now() + delay,
            consecutive,
        });
    }

    /** WAIT 轮末/探针等「立即评估」入口：仍受在飞去重约束（在飞则合并为 queued） */
    requestNow(candidate: Omit<DecisionCandidate, 'at'>): void {
        this.dispatch({ ...candidate, at: this.now() });
    }

    /** 在飞去重 + 合并：在飞结束立即补跑排队的最新候选（不丢、不叠） */
    private dispatch(candidate: DecisionCandidate): void {
        const sid = candidate.session.sessionId;
        if (!this.onDue) return;
        if (this.inflight.has(sid)) {
            this.queued.set(sid, candidate);
            return;
        }
        this.inflight.add(sid);
        let settled = false;
        const done = (): void => {
            if (settled) return;
            settled = true;
            this.inflight.delete(sid);
            const next = this.queued.get(sid);
            if (!next) return;
            this.queued.delete(sid);
            this.scheduler.setTimeout(() => this.dispatch(next), 1);
        };
        try {
            this.onDue(candidate).catch((e: unknown) => {
                log.warning(`判定执行失败：${e instanceof Error ? e.message : String(e)}`);
            }).then(done, done);
        } catch (e) {
            log.warning(`判定入口同步失败：${e instanceof Error ? e.message : String(e)}`);
            done();
        }
    }

    /** 取消某会话的去抖（新消息覆盖 / .ai off / stop / 规则删除） */
    cancel(sid: string): boolean {
        const entry = this.pending.get(sid);
        if (!entry) return false;
        this.scheduler.clearTimeout(entry.timer);
        this.pending.delete(sid);
        return true;
    }

    /** 是否有待评估候选 */
    hasPending(sid: string): boolean {
        return this.pending.has(sid);
    }

    /** 在飞标记：同一会话同时只允许一次判定 LLM 调用 */
    markInflight(sid: string): boolean {
        if (this.inflight.has(sid)) return false;
        this.inflight.add(sid);
        return true;
    }

    clearInflight(sid: string): void {
        this.inflight.delete(sid);
    }

    isInflight(sid: string): boolean {
        return this.inflight.has(sid);
    }

    /** 静默探针：默认关（调用方按 TOML [probe] enabled 决定是否 arm） */
    armProbe(sid: string, firstGapSec: number, now = this.now()): void {
        this.probes.set(sid, { nextAt: now + Math.max(1, firstGapSec) * 1000, gapSec: Math.max(1, firstGapSec) });
    }

    /** 探针退避（×backoff，上限 maxGapSec） */
    backoffProbe(sid: string, backoff: number, maxGapSec: number, now = this.now()): void {
        const state = this.probes.get(sid);
        if (!state) return;
        state.gapSec = Math.min(state.gapSec * Math.max(1, backoff), Math.max(1, maxGapSec));
        state.nextAt = now + state.gapSec * 1000;
    }

    probeNextAt(sid: string): number | null {
        return this.probes.get(sid)?.nextAt ?? null;
    }

    cancelProbe(sid: string): void {
        this.probes.delete(sid);
    }

    /** 会话清理：去抖 + 排队 + 探针 + 在飞一律清掉（.ai off / stop / 会话销毁 / LRU） */
    cancelForSession(sid: string): void {
        this.cancel(sid);
        this.cancelProbe(sid);
        this.clearInflight(sid);
        this.queued.delete(sid);
    }

    clearAll(): void {
        for (const sid of [...this.pending.keys()]) this.cancel(sid);
        this.probes.clear();
        this.inflight.clear();
        this.queued.clear();
    }

    /** 观测：是否有排队候选（在飞结束后补跑） */
    hasQueued(sid: string): boolean {
        return this.queued.has(sid);
    }

    /** 调试/观测：待评估与在飞会话数 */
    stats(): { pending: number; inflight: number; probes: number } {
        return { pending: this.pending.size, inflight: this.inflight.size, probes: this.probes.size };
    }
}

/** 生产单例（内存；未接线前不产生任何定时器） */
export const decisionSchedule = new DecisionSchedule();
