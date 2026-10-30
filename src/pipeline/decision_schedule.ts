// 判定入口调度（L4，内存瞬时语义）：消息去抖、静默探针、在飞标记。
//
// 方案 §6.4/C5：这三类语义**不进 timerQueue**（避免 5s 轮询污染），重载即丢（文档化）。
// M3 只提供实现与默认关闭的探针；接线与治理（去抖生效/在飞/pending 合并）属 R2。
import { logger } from "../logger";
import type { Session } from "../session/session";

const log = logger.withTag('decision-schedule');

export interface DecisionCandidate {
    session: Session;
    ctx: seal.MsgContext;
    msg: seal.Message;
    text: string;
    /** 入队时间（毫秒） */
    at: number;
}

export interface DecisionDueHandler {
    (candidate: DecisionCandidate): Promise<void>;
}

interface PendingCandidate extends DecisionCandidate {
    timer: unknown;
    deadline: number;
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

    /** 消息去抖：4~12s（取 min(DEBOUNCE_MAX, DEBOUNCE * 2^连发次数) 由调用方算好传入） */
    schedule(candidate: Omit<DecisionCandidate, 'at'>, debounceMs: number): void {
        const sid = candidate.session.sessionId;
        this.cancel(sid);
        const timer = this.scheduler.setTimeout(() => {
            this.pending.delete(sid);
            if (!this.onDue) return;
            this.onDue({ ...candidate, at: this.now() }).catch((e: unknown) => {
                log.warning(`判定去抖到期执行失败：${e instanceof Error ? e.message : String(e)}`);
            });
        }, Math.max(1, debounceMs));
        this.pending.set(sid, { ...candidate, at: this.now(), timer, deadline: this.now() + debounceMs });
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

    /** 会话清理：去抖 + 探针 + 在飞一律清掉（.ai off / stop / 会话销毁 / LRU） */
    cancelForSession(sid: string): void {
        this.cancel(sid);
        this.cancelProbe(sid);
        this.clearInflight(sid);
    }

    clearAll(): void {
        for (const sid of [...this.pending.keys()]) this.cancel(sid);
        this.probes.clear();
        this.inflight.clear();
    }

    /** 调试/观测：待评估与在飞会话数 */
    stats(): { pending: number; inflight: number; probes: number } {
        return { pending: this.pending.size, inflight: this.inflight.size, probes: this.probes.size };
    }
}

/** 生产单例（内存；未接线前不产生任何定时器） */
export const decisionSchedule = new DecisionSchedule();
