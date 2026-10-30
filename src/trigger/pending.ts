// delay 挂起槽（L2 纯能力，内存、不持久化）：链 delay 门与单模式延迟共用同一引擎。
//
// 方案 §5.4/§5.8：
// - 键 `ruleId@sid`（链规则）或 `mode:delay@sid`（单触发延迟）；同键再次命中即重置计时；
// - 上限 100，超出时丢弃最早加入的槽并回调 onDropped（便于日志/状态统计）；
// - 调度器注入（默认全局 setTimeout），单测可用假时钟；重载后丢失（文档化）。
export interface DelaySlot<T = unknown> {
    key: string;
    /** 规则 id；单模式延迟为 `mode:delay` */
    ruleId: string;
    sessionId: string;
    /** delay 门在 gates 中的下标（到期后从 index+1 继续）；单模式为 -1 */
    gateIndex: number;
    /** 到期时间戳（毫秒） */
    dueAt: number;
    /** 到期回调载荷（ctx/msg/计数器等由调用方自带） */
    payload: T;
    /** 定时器句柄（注入调度器返回） */
    timer: unknown;
}

export interface DelayScheduler {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const defaultScheduler: DelayScheduler = {
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DELAY_PENDING_MAX = 100;

export class PendingDelays<T = unknown> {
    private slots = new Map<string, DelaySlot<T>>();
    private scheduler: DelayScheduler;
    private max: number;

    constructor(scheduler: DelayScheduler = defaultScheduler, max: number = DELAY_PENDING_MAX) {
        this.scheduler = scheduler;
        this.max = max;
    }

    get size(): number {
        return this.slots.size;
    }

    has(key: string): boolean {
        return this.slots.has(key);
    }

    get(key: string): DelaySlot<T> | undefined {
        return this.slots.get(key);
    }

    /**
     * 起/重置一个挂起槽。同键已有槽时先取消旧计时（"静默 N 秒才继续"语义）。
     * @param onDropped 超上限淘汰最旧槽时回调（可选）
     */
    arm(key: string, meta: Omit<DelaySlot<T>, 'key' | 'dueAt' | 'timer'>, delaySec: number, onDue: (slot: DelaySlot<T>) => void, onDropped?: (slot: DelaySlot<T>) => void): DelaySlot<T> {
        this.cancel(key);
        if (this.slots.size >= this.max) {
            const oldestKey = this.slots.keys().next().value as string | undefined;
            if (oldestKey !== undefined) {
                const oldest = this.slots.get(oldestKey);
                this.cancel(oldestKey);
                if (oldest) onDropped?.(oldest);
            }
        }
        const dueAt = Date.now() + Math.max(1, delaySec) * 1000;
        const slot: DelaySlot<T> = { key, ...meta, dueAt, timer: null };
        slot.timer = this.scheduler.setTimeout(() => {
            this.slots.delete(key);
            onDue(slot);
        }, Math.max(1, delaySec) * 1000);
        this.slots.set(key, slot);
        return slot;
    }

    /** 取消单个槽（规则删除/失败/关闸） */
    cancel(key: string): boolean {
        const slot = this.slots.get(key);
        if (!slot) return false;
        this.scheduler.clearTimeout(slot.timer);
        this.slots.delete(key);
        return true;
    }

    /** 取消某规则的全部挂起（规则删除/停用/用尽） */
    cancelRule(ruleId: string): number {
        let count = 0;
        for (const [key, slot] of [...this.slots.entries()]) {
            if (slot.ruleId !== ruleId) continue;
            this.cancel(key);
            count++;
        }
        return count;
    }

    /** 取消某会话的全部挂起（`.ai off`/stop/会话销毁） */
    cancelSession(sessionId: string): number {
        let count = 0;
        for (const [key, slot] of [...this.slots.entries()]) {
            if (slot.sessionId !== sessionId) continue;
            this.cancel(key);
            count++;
        }
        return count;
    }

    /** 清空全部（`.ai off`/重载） */
    clear(): number {
        const count = this.slots.size;
        for (const slot of this.slots.values()) this.scheduler.clearTimeout(slot.timer);
        this.slots.clear();
        return count;
    }

    /** 当前所有槽（只读快照，调试/状态展示用） */
    list(): DelaySlot<T>[] {
        return [...this.slots.values()];
    }
}
