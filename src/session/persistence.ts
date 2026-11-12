// 会话持久化（叶子）：运行时字段排除、序列化、分片键与保存节流判定。
// 从 session.ts 拆出——序列化规则与节流参数属于存储契约，和会话业务逻辑无关，
// 由 session.ts / session_service.ts 共用，避免两边各写一份 JSON.stringify replacer。
import { getHost } from "../core/host";

/** 保存节流：合并写的最小间隔与批量上限（海豹 storage 为叠加式，重复写会持续占空间；见 docs/03 上下文模块） */
export const SAVE_MIN_INTERVAL_MS = 5000;
export const SAVE_BATCH = 20;

/** 持久化时排除的运行时字段（监听器/运行状态/挂起队列/节流状态等），不写入存储、不参与 revive 恢复 */
export const SESSION_RUNTIME_KEYS = new Set(['lastCtx', 'running', 'starting', 'stopVersion', 'pendingQueue', 'activeRuns', 'stopEvent', 'headless', 'toolRestriction', 'parentSessionId', 'subagentDepth', 'noticeQueue', 'headlessTranscript', 'saveTimer', 'lastSaveAt', 'saveDeferCount', 'lastRelevantAt', 'ctxStats', 'settleBackoffUntil', 'failStreak', 'lastRuleTimerEnsureAt', 'contextV2', 'quotaSessionId', 'quotaUserId',
    // #163 D7-05：前缀 rebase 记账与上轮请求快照都是纯运行时观测（不落盘，理由见 Session 字段注释）
    'prefixRebase', 'prefixSnapshot', 'rebaseBootNoted', 'injectionAnchorSeq', 'prefixObservation', 'lastSummaryStale',
    // #163 D9-03/D9-04：缓存命中率滚动窗口与漂移探针同样是纯观测
    'cacheWindow', 'prefixProbeEnabled', 'prefixProbe']);

/**
 * rebase 白名单里**配置分区**的键（#163 REQ-D7-06 ⑤）：
 * 只有这些分区的变更会改变渲染字节，因此只有它们能触发 `config:<key>` rebase。
 *
 * 放 persistence（L1 叶子）而不是 session：config/hooks（L2）要引用它，
 * 若放 session（L3）就变成 L2 → L3 的反向依赖。
 */
export const CONFIG_REBASE_KEYS = [
    'context', 'tool', 'role', 'image', 'model', 'subagent', 'knowledgeBase',
] as const;

// 引导期归因（reload/upgrade/tools）放在 L0 的 `core/prefix_boot.ts`：
// 读它的 `utils/message.ts`（L2）不能反向依赖 session（L3），见该文件头注释。
export { initBootRebaseCause, takeBootRebaseCause, resetBootRebaseCauseForTest } from "../core/prefix_boot";
export type { BootRebaseCause } from "../core/prefix_boot";

/** 会话忙时挂起的消息：运行中收到的新消息先入队，由下一轮模型请求前统一入库（触发类可在链结束后续跑一轮） */
export interface PendingMessage {
    ctx: seal.MsgContext;
    msg: seal.Message;
    content: string;
    userId: string;
    messageId: string;
    kind: 'trigger' | 'record';
    systemReason?: string;
    /** 系统提示的名义（缺省 trigger；事件触发挂起用 event-trigger） */
    systemName?: string;
    /** 落盘轻量字段：重载后用于重建 ctx/msg（getSessionCtxAndMsg）与续跑 */
    epId: string;
    isPrivate: boolean;
    /** 引用回复的被引 msgId（REQ-D6-11；忙态只记录不展开，flush 时才做网络/IO） */
    quoteOf?: string;
}

/** 会话主体的存储键 */
export function sessionStorageKey(sessionId: string): string {
    return `session_${sessionId}`;
}

/** 挂起队列轻量分片 key：ctx/msg 是运行时对象不可序列化，只落盘重建所需字段，变更即写穿 */
export function pendingKey(sessionId: string): string {
    return `session_${sessionId}:pending`;
}

/** 序列化会话主体：排除运行时字段（监听器/计时器/在途状态）；v2 已启用时不再写旧 messages 数组 */
export function serializeSession(session: object): string {
    return JSON.stringify(session, function (key, value) {
        return SESSION_RUNTIME_KEYS.has(key) ? undefined : value;
    });
}

/** 序列化挂起队列（只保留可落盘的轻量字段） */
export function serializePendingQueue(queue: PendingMessage[]): string {
    return JSON.stringify(queue.map(p => ({
        content: p.content,
        userId: p.userId,
        messageId: p.messageId,
        kind: p.kind,
        systemReason: p.systemReason,
        systemName: p.systemName,
        epId: p.epId,
        isPrivate: p.isPrivate,
        // 旧挂起分片没有该字段（undefined 被 JSON 丢弃）⇒ 读回 undefined，行为与改造前一致
        quoteOf: p.quoteOf,
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
