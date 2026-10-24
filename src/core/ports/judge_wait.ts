// 评分 WAIT 轮末端口（L0 叶子）：judge ↔ timer 的双向协作经此端口，双方互不 import。
// - judge → timer：安排/取消 judgeWait 兜底定时器（scheduler 由 timer 模块加载时注册）
// - timer → judge：到点后让 judge 收尾本轮（finisher 由 judge 模块加载时注册）
// 未注册时调用静默跳过（与"定时器队列为空"的语义一致，便于测试/裁剪场景）。
import type { Session } from "../../session/session";

export interface JudgeWaitScheduler {
    schedule(ctx: seal.MsgContext, session: Session, target: number): void;
    cancel(sid: string): void;
}

export type JudgeWaitFinisher = (sid: string) => Promise<boolean>;

let scheduler: JudgeWaitScheduler | null = null;
let finisher: JudgeWaitFinisher | null = null;

/** 由 timer 模块在加载时注册（实现为 TimerManager 的 judgeWait 定时器操作） */
export function setJudgeWaitScheduler(next: JudgeWaitScheduler | null): void {
    scheduler = next;
}

/** 由 judge 模块在加载时注册（实现为 JudgeManager.endWaitRound） */
export function setJudgeWaitFinisher(next: JudgeWaitFinisher | null): void {
    finisher = next;
}

/** 安排评分轮末兜底定时器（同一会话只应有一个，调用方先 cancel） */
export function scheduleJudgeWait(ctx: seal.MsgContext, session: Session, target: number): void {
    scheduler?.schedule(ctx, session, target);
}

/** 取消某会话的评分轮末定时器 */
export function cancelJudgeWait(sid: string): void {
    scheduler?.cancel(sid);
}

/** 定时器到点：让 judge 收尾本轮；返回 false 表示尚未到点（waitUntil 被延长），由调用方决定是否保留定时器 */
export async function finishJudgeWaitRound(sid: string): Promise<boolean> {
    if (!finisher) return true;
    return finisher(sid);
}
