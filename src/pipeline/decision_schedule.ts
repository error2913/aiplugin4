// 判定入口调度（L4，内存瞬时语义）：只保留「同会话在飞去重 + 最新候选合并」。
//
// 去抖、静默探针、30s 延迟窗口都不在这里：消息到达立即进入 JudgeManager.evaluate；
// WAIT 挂起由 judge 自己的 30s 窗口负责。这里仅防止同一会话并发调模型/重复起轮。
import { logger } from "../logger";
import type { Session } from "../session/session";

const log = logger.withTag('decision-schedule');

/** 判定触发源 */
export type DecisionSource = 'message' | 'wait';

export interface DecisionCandidate {
    session: Session;
    ctx: seal.MsgContext;
    msg: seal.Message;
    text: string;
    /** 入队时间（毫秒） */
    at: number;
    /** 触发源：新消息 / WAIT 到点重评 */
    source?: DecisionSource;
    /** 是否 @/点名了 bot（特征用） */
    addressed?: boolean;
    /** 发送者 UNI-ID（特征层用） */
    senderId?: string;
}

export interface DecisionDueHandler {
    (candidate: DecisionCandidate): Promise<void>;
}

export class DecisionSchedule {
    private inflight = new Set<string>();
    /** 在飞期间到达的最新候选（合并，不排队叠加；在飞结束后立即补跑一次） */
    private queued = new Map<string, DecisionCandidate>();
    private onDue: DecisionDueHandler | null = null;

    /** 装配回调：到期后真正进入判定（由 pipeline 提供） */
    setHandler(handler: DecisionDueHandler | null): void {
        this.onDue = handler;
    }

    /** 立即评估（消息 / WAIT 到点）：仍受同会话在飞去重约束 */
    requestNow(candidate: Omit<DecisionCandidate, 'at'>): void {
        this.dispatch({ ...candidate, at: Date.now() });
    }

    /** 在飞去重 + 合并：在飞结束立即补跑排队的最新候选 */
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
            this.dispatch(next);
        };
        try {
            this.onDue(candidate).catch((e: unknown) => {
                log.warning('判定执行失败：' + (e instanceof Error ? e.message : String(e)));
            }).then(done, done);
        } catch (e) {
            log.warning('判定入口同步失败：' + (e instanceof Error ? e.message : String(e)));
            done();
        }
    }

    /** 取消某会话的排队（不打断已经在飞的请求；其结果由 judge 代际丢弃） */
    cancel(sid: string): boolean {
        return this.queued.delete(sid);
    }

    /** 会话清理：排队 + 在飞标记 */
    cancelForSession(sid: string): void {
        this.queued.delete(sid);
        this.inflight.delete(sid);
    }

    clearAll(): void {
        this.inflight.clear();
        this.queued.clear();
    }

    hasQueued(sid: string): boolean {
        return this.queued.has(sid);
    }

    stats(): { inflight: number; queued: number } {
        return { inflight: this.inflight.size, queued: this.queued.size };
    }
}

/** 生产单例（内存；未接线前不产生任何定时器） */
export const decisionSchedule = new DecisionSchedule();
