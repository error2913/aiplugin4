// 会话持久化（叶子）：运行时字段排除、序列化、分片键与保存节流判定。
// 从 session.ts 拆出——序列化规则与节流参数属于存储契约，和会话业务逻辑无关，
// 由 session.ts / session_service.ts 共用，避免两边各写一份 JSON.stringify replacer。
import { getHost } from "../core/host";

/** 保存节流：合并写的最小间隔与批量上限（海豹 storage 为叠加式，重复写会持续占空间；见 docs/03 上下文模块） */
export const SAVE_MIN_INTERVAL_MS = 5000;
export const SAVE_BATCH = 20;

/** 持久化时排除的运行时字段（监听器/运行状态/挂起队列/节流状态等），不写入存储、不参与 revive 恢复 */
export const SESSION_RUNTIME_KEYS = new Set(['lastCtx', 'running', 'starting', 'stopVersion', 'pendingQueue', 'activeRuns', 'stopEvent', 'headless', 'toolRestriction', 'parentSessionId', 'subagentDepth', 'noticeQueue', 'headlessTranscript', 'saveTimer', 'lastSaveAt', 'saveDeferCount', 'lastRelevantAt', 'ctxStats', 'settleBackoffUntil', 'contextV2']);

/** 会话忙时挂起的消息：运行中收到的新消息先入队，由下一轮模型请求前统一入库（触发类可在链结束后续跑一轮） */
export interface PendingMessage {
    ctx: seal.MsgContext;
    msg: seal.Message;
    content: string;
    userId: string;
    messageId: string;
    kind: 'trigger' | 'record';
    systemReason?: string;
    /** 落盘轻量字段：重载后用于重建 ctx/msg（getSessionCtxAndMsg）与续跑 */
    epId: string;
    isPrivate: boolean;
}

/** 会话主体的存储键 */
export function sessionStorageKey(sessionId: string): string {
    return `session_${sessionId}`;
}

/** 挂起队列轻量分片 key：ctx/msg 是运行时对象不可序列化，只落盘重建所需字段，变更即写穿 */
export function pendingKey(sessionId: string): string {
    return `session_${sessionId}:pending`;
}

/** 序列化会话主体：排除运行时字段（监听器/计时器/在途状态） */
export function serializeSession(session: object): string {
    return JSON.stringify(session, (key, value) => SESSION_RUNTIME_KEYS.has(key) ? undefined : value);
}

/** 序列化挂起队列（只保留可落盘的轻量字段） */
export function serializePendingQueue(queue: PendingMessage[]): string {
    return JSON.stringify(queue.map(p => ({
        content: p.content,
        userId: p.userId,
        messageId: p.messageId,
        kind: p.kind,
        systemReason: p.systemReason,
        epId: p.epId,
        isPrivate: p.isPrivate,
    })));
}

/** 合并写节流判定：距离上次落盘不足间隔且未到批量上限 => 本次可延迟 */
export function shouldDeferCoalescedSave(lastSaveAt: number, deferCount: number, now: number): boolean {
    return now - lastSaveAt < SAVE_MIN_INTERVAL_MS && deferCount < SAVE_BATCH;
}

/** 写会话主体（唯一落盘点，便于统计/替换存储实现） */
export function writeSessionRecord(sessionId: string, session: object): void {
    getHost().storage.set(sessionStorageKey(sessionId), serializeSession(session));
}

/** 写挂起队列分片；空字符串表示清空 */
export function writePendingRecord(sessionId: string, queue: PendingMessage[] | null): void {
    getHost().storage.set(pendingKey(sessionId), queue ? serializePendingQueue(queue) : '');
}
