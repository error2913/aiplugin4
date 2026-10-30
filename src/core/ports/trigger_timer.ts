// 触发域 ↔ TimerManager 双向端口（L0）：双方各自注册一半，避免 trigger(L2) ↔ timer(L2) 互相 import。
//
// 方向 A（timer → trigger）：TimerManager.task() 到点后先问 owns()，是规则/模式条目则交给 fire()。
// 方向 B（trigger → timer）：trigger 需要注册/取消/查询规则定时器时经 scheduler 回调。
// 范式与 core/ports/judge_wait.ts 一致：未注册时静默跳过（测试/裁剪场景等价于"队列无条目"）。
import type { TimerInfo } from "../../timer";

/** 规则定时器的注册参数（调度语义与 set_timer 同名字段；prompts 为 fire 时的唤醒文本） */
export interface RuleTimerSpec {
    /** 规则 id（隐式模式规则用 `mode:<sid>` 形式） */
    ruleId: string;
    /** 条目归属：隐式模式规则 / 门控链规则 */
    modeTag: 'mode' | 'rule';
    /** target=绝对时间一次性（unix 秒）；interval=周期（秒） */
    type: 'target' | 'interval';
    target?: number;
    interval?: number;
    /** 触发次数：-1 无限；target 一次性固定 1 */
    count: number;
    /** 多条唤醒提示（1~10）；为空时回退内置默认文案 */
    prompts?: string[];
}

/** 规则定时器的目标会话（显式传入，不从当前 ctx 推导：规则可跨会话） */
export interface RuleTimerTarget {
    sid: string;
    isPrivate: boolean;
    epId: string;
}

/** 方向 B：timer 模块把"增删查"实现注册到这里，trigger 通过函数调用 */
export interface TriggerTimerScheduler {
    addRuleTimer(target: RuleTimerTarget, spec: RuleTimerSpec): void;
    removeRuleTimers(ruleId: string): void;
    listRuleTimers(ruleId?: string): TimerInfo[];
}

/** 方向 A：trigger 把"认领/回火"实现注册到这里，TimerManager 分派前调用 */
export interface TriggerTimerHandler {
    /** 是否由触发域处理该条目（只认 ruleId 存在的规则/模式条目） */
    owns(timer: TimerInfo): boolean;
    /** 到点执行（trigger 内部负责判闸、渲染 prompt、起轮） */
    fire(timer: TimerInfo): Promise<void>;
}

let scheduler: TriggerTimerScheduler | null = null;
let handler: TriggerTimerHandler | null = null;

/** 由 timer 模块在加载时注册（方向 B 实现） */
export function setTriggerTimerScheduler(next: TriggerTimerScheduler | null): void {
    scheduler = next;
}

/** 由 trigger 模块在加载时注册（方向 A 实现） */
export function setTriggerTimerHandler(next: TriggerTimerHandler | null): void {
    handler = next;
}

/** 规则 timer 是否存在调度实现（未注册时规则 timer 功能静默不可用） */
export function hasTriggerTimerScheduler(): boolean {
    return scheduler !== null;
}

export function addRuleTimer(target: RuleTimerTarget, spec: RuleTimerSpec): void {
    scheduler?.addRuleTimer(target, spec);
}

export function removeRuleTimers(ruleId: string): void {
    scheduler?.removeRuleTimers(ruleId);
}

export function listRuleTimers(ruleId?: string): TimerInfo[] {
    return scheduler ? scheduler.listRuleTimers(ruleId) : [];
}

/** TimerManager 分派前调用：未注册 handler 一律 false（走旧分支） */
export function ownsTriggerTimer(timer: TimerInfo): boolean {
    return handler ? handler.owns(timer) : false;
}

/** TimerManager 到点调用：未注册 handler 时按"已消费"返回，避免卡住队列 */
export async function fireTriggerTimer(timer: TimerInfo): Promise<void> {
    if (handler) await handler.fire(timer);
}
