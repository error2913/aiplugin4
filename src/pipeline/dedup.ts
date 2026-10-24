// 消息管线去重/配对状态（叶子）：核心回调 ↔ ob11 依赖补收的配对表、墓碑与事件"后到覆盖先到"引用表。
// 从 pipeline.ts 拆出——这些是纯状态机（Map + TTL + 容量淘汰），与管线编排/事件分发解耦；
// pipeline.ts 保留 re-export（filterOb11SupplementSegments），外部 import 零改动。
import type { SystemEntryRef } from "../context/context";
import { EVENT_DEDUP_WINDOW_MS } from "../event/notice";
import { getRecordMessageId, transformMsgId } from "../utils/message_id";
import type { MessageSegment } from "../utils/string";
/** 核心原生 milky 路径通常过滤掉的段，只由 ob11 依赖补充。 */
const OB11_SUPPLEMENT_SEGMENT_TYPES = new Set(['record', 'json', 'video', 'file', 'node', 'forward', 'music', 'xml', 'markdown', 'market_face']);
const CORE_MESSAGE_TTL_MS = 2000;
const DEPENDENCY_WAIT_MS = 100;
/** 核心/依赖配对表最大条目数：超限时淘汰最旧一项，防极端洪峰下内存失控 */
const CORE_STATES_MAX = 5000;

export interface CoreMessageState {
    expiresAt: number;
    recorded: boolean;
    /** 该 key 已由依赖路径整条兜底处理（完整入库/可能已触发 AI）：核心回调迟到时应放弃，避免双录/双触发 */
    depFull?: boolean;
    types: Set<string>;
}

const coreMessageStates = new Map<string, CoreMessageState>();

function pruneCoreMessageStates(now: number = Date.now()): void {
    coreMessageStates.forEach((state, key) => {
        if (state.expiresAt <= now) coreMessageStates.delete(key);
    });
}

/** 尺寸兜底：超限时淘汰最旧一项 */
function capCoreMessageStates(): void {
    if (coreMessageStates.size <= CORE_STATES_MAX) return;
    const oldest = coreMessageStates.keys().next().value;
    if (oldest !== undefined) coreMessageStates.delete(oldest);
}

export function getMessageKey(ctx: seal.MsgContext, msg: seal.Message): string {
    const sessionId = ctx.isPrivate ? ctx.player?.userId || '' : ctx.group?.groupId || '';
    const messageId = getRecordMessageId(ctx, msg) || transformMsgId(msg.rawId);
    return `${ctx.endPoint.userId}|${sessionId}|${messageId}`;
}

export function rememberCoreMessageByKey(key: string, messageArray: MessageSegment[]): void {
    pruneCoreMessageStates();
    coreMessageStates.set(key, {
        expiresAt: Date.now() + CORE_MESSAGE_TTL_MS,
        recorded: false,
        types: new Set(messageArray
            .filter(item => item.type !== 'text')
            .map(item => item.type === 'at' && item.data && item.data.qq === 'all' ? 'at:all' : item.type))
    });
    capCoreMessageStates();
}

export function markCoreMessageRecorded(key: string): void {
    const state = coreMessageStates.get(key);
    if (state) state.recorded = true;
}

export function getCoreMessageState(key: string): CoreMessageState | undefined {
    pruneCoreMessageStates();
    return coreMessageStates.get(key);
}

/** 依赖路径已整条兜底处理（核心没有对应回调）后打墓碑：核心回调迟到时据此放弃，避免双录/双触发 */
export function markDependencyFullRecorded(key: string): void {
    pruneCoreMessageStates();
    coreMessageStates.set(key, {
        expiresAt: Date.now() + CORE_MESSAGE_TTL_MS,
        recorded: true,
        depFull: true,
        types: new Set(),
    });
    capCoreMessageStates();
}

/** 消费墓碑：存在且标记为依赖整条兜底时删除并返回 true（核心应放弃本次处理） */
export function consumeDependencyTombstone(key: string): boolean {
    pruneCoreMessageStates();
    const state = coreMessageStates.get(key);
    if (state && state.depFull) {
        coreMessageStates.delete(key);
        return true;
    }
    return false;
}

/** 事件"后到覆盖先到"引用表：去重窗口内同 key 只保留一条上下文事件，
 *  重复到达（echo/双路径/内容无法区分的兜底情况）时用最后到达的副本就地替换，不再简单丢弃。 */
interface EventEntryRefState {
    expiresAt: number;
    ref: SystemEntryRef;
}
const eventEntryRefs = new Map<string, EventEntryRefState>();
const EVENT_ENTRY_REF_MAX = 5000;

function pruneEventEntryRefs(now: number): void {
    eventEntryRefs.forEach((state, key) => {
        if (state.expiresAt <= now) eventEntryRefs.delete(key);
    });
}

/** 记录某去重 key 当前在上下文中的事件条目位置（与 EVENT_DEDUP_WINDOW_MS 同生命周期） */
export function rememberEventEntryRef(key: string, ref: SystemEntryRef): void {
    pruneEventEntryRefs(Date.now());
    eventEntryRefs.set(key, { expiresAt: Date.now() + EVENT_DEDUP_WINDOW_MS, ref });
    if (eventEntryRefs.size > EVENT_ENTRY_REF_MAX) {
        const oldest = eventEntryRefs.keys().next().value;
        if (oldest !== undefined) eventEntryRefs.delete(oldest);
    }
}

/** 依赖事件只筛选核心缺失段；face 由核心是否已收到动态决定。 */
export function filterOb11SupplementSegments(message: any[], coreTypes?: Set<string>): any[] {
    return message.filter((seg: any) => {
        if (!seg || typeof seg !== 'object' || !seg.type) return false;
        if (OB11_SUPPLEMENT_SEGMENT_TYPES.has(seg.type)) return true;
        if (seg.type === 'at' && seg.data && seg.data.qq === 'all') return !coreTypes?.has('at:all');
        return seg.type === 'face' && !coreTypes?.has('face');
    });
}

export function waitForCoreEvent(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, DEPENDENCY_WAIT_MS));
}

/** 读取事件"后到覆盖先到"引用（过期视为不存在） */
export function getEventEntryRef(key: string): SystemEntryRef | undefined {
    const state = eventEntryRefs.get(key);
    if (!state || state.expiresAt <= Date.now()) return undefined;
    return state.ref;
}

/** 删除某消息键的配对状态（依赖路径已处理/核心放弃时清理） */
export function deleteCoreMessageState(key: string): void {
    coreMessageStates.delete(key);
}