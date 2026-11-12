// Context v2 事件与记录类型（唯一事实源的契约层）。
// 只放类型、常量与纯函数；不依赖 seal / storage / Config，便于单测与依赖分层。
import type { ToolContentPart } from "../tool/types";

/** 存储/页/schema 版本：不兼容变更时递增 */
export const CONTEXT_SCHEMA_VERSION = 2;

// ---------------- 内容 AST（唯一内部表示） ----------------

export type Part =
    | { type: 'text'; text: string }
    | { type: 'mention'; id: string; all?: true }
    | { type: 'quote'; id: string }
    | { type: 'image'; ref: string; desc?: string }
    | { type: 'avatar'; uid: string }
    | { type: 'group_avatar'; gid: string }
    | { type: 'record'; handle: string; summary?: string }
    | { type: 'video'; handle: string; summary?: string }
    | { type: 'file'; handle: string; summary?: string }
    | { type: 'face'; name: string }
    | { type: 'poke'; id: string }
    | { type: 'forward'; id: string }
    | { type: 'markdown'; text: string }
    | { type: 'resource'; uri: string; name?: string; mime?: string }
    | { type: 'unknown'; tag: string; content: string };

// ---------------- 事件 ----------------

export interface EventBase {
    /** 会话内单调递增，写入时分配；purge 后也不复用 */
    seq: number;
    /** 稳定事件 id，用于重放/双路径去重 */
    eventId: string;
    /** 事件发生时间（秒） */
    at: number;
    /** 到达/接收时间（秒）；排序/覆盖/TTL 以它和 seq 为准 */
    recvAt: number;
}

export interface UserEvent extends EventBase {
    kind: 'user';
    /**
     * 来源标记：self=机器人自录消息；quote=引用回复展开出的被引原文（REQ-D6-04）。
     * 注意 records.ts 的 redact 判定按 `origin !== 'self'` 归 user 侧，quote 因此可被"隐藏用户消息"覆盖。
     */
    origin?: 'self' | 'quote';
    uid: string;
    msgId: string;
    parts: Part[];
    /** 写入时冻结的显示名（REQ-D6-05；旧数据缺失时渲染回退活动昵称） */
    fromName?: string;
    /** 引用关系：本事件是"被引用的原始消息"，值为原 msgId（REQ-D6-05；语义标签，不受 msg_id 门控影响） */
    quoteOf?: string;
}

/**
 * 引用展开结果（REQ-D6-01 ~ D6-05）：被引原始消息的冻结快照，不含任何渲染。
 * 渲染（`[from:<name>][quote_of:<id>]`）由 view/compile 负责，数据层只负责冻结内容。
 */
export interface QuoteDraft {
    /** 被引消息的 base36 短 id（= UserEvent.msgId = quoteOf 值） */
    msgId: string;
    /** 原发言人 UNI-ID（如 QQ:123）；未知时 'unknown'（page_store 要求 uid 非空） */
    uid: string;
    /** 写入时冻结的显示名 */
    fromName: string;
    /** 原始消息完整 parts（含 {type:'image', ref}，走与普通 user 事件同一写入路径） */
    parts: Part[];
}

export interface AssistantEvent extends EventBase {
    kind: 'assistant';
    msgId: string;
    parts: Part[];
    /** thinking mode 下必须原样回传 */
    reasoning?: string;
}

export interface ToolCallEvent extends EventBase {
    kind: 'tool_call';
    /** 一次模型调用内的全部工具调用共享 */
    turnId: string;
    /** 单次调用与其结果共享 */
    groupId: string;
    callId: string;
    name: string;
    /** 原始 JSON 字符串（保持模型/工具侧原样） */
    args: string;
    reasoning?: string;
}

export interface ToolResultEvent extends EventBase {
    kind: 'tool_result';
    turnId: string;
    groupId: string;
    callId: string;
    name?: string;
    parts: Part[];
    /** 原始结构化内容块（MCP 图片等），与 parts 二选一/互补；由内容层归一化后写入 */
    contentParts?: ToolContentPart[];
}

export interface SystemEvent extends EventBase {
    kind: 'event';
    systemName: string;
    eventType?: string;
    parts: Part[];
    /** 事件原始数据（不渲染给模型，仅供 read_raw kind=event 读取） */
    raw?: unknown;
}

export type ConversationEvent =
    | UserEvent
    | AssistantEvent
    | ToolCallEvent
    | ToolResultEvent
    | SystemEvent;

/** 追加时由调用方给出的草稿：seq 由 store 分配；eventId 可由 store 兜底生成 */
type Draft<T extends EventBase> = Omit<T, 'seq' | 'eventId' | 'at' | 'recvAt'> & {
    eventId?: string;
    at?: number;
    recvAt?: number;
};

export type EventInput =
    | Draft<UserEvent>
    | Draft<AssistantEvent>
    | Draft<ToolCallEvent>
    | Draft<ToolResultEvent>
    | Draft<SystemEvent>;

// ---------------- 记录（所有"改写/删除/摘要"的唯一表达） ----------------

export interface RecordBase {
    id: string;
    at: number;
}

/** 滚动摘要：每 epoch 一条有效（编译时取 toSeq 最大且满足覆盖条件者） */
export interface SummaryRecord extends RecordBase {
    kind: 'summary';
    epoch: number;
    fromSeq: number;
    toSeq: number;
    text: string;
    model?: string;
    promptVersion?: number;
    /** 摘要覆盖区间的最早事件时间（Unix 秒，可选；旧记录无此字段） */
    fromAt?: number;
    /** 摘要覆盖区间的最晚事件时间（Unix 秒，可选；旧记录无此字段） */
    toAt?: number;
}

/** 有意编辑：展示与召回都以补丁为准 */
export interface EditRecord extends RecordBase {
    kind: 'edit';
    seq: number;
    parts: Part[];
}

/** 事件去重"后到覆盖先到"：同 dedupKey 只保留最新 seq */
export interface SupersedeRecord extends RecordBase {
    kind: 'supersede';
    dedupKey: string;
    seq: number;
}

/** 逻辑遗忘：模型/召回不可见，原文保留 */
export interface RedactRecord extends RecordBase {
    kind: 'redact';
    epoch: number;
    fromSeq: number;
    toSeq: number;
    target: 'user' | 'assistant' | 'all';
}

/** 全清除后的 epoch 起点 */
export interface EpochResetRecord extends RecordBase {
    kind: 'epoch';
    epoch: number;
    startSeq: number;
}

export type RecordEntry =
    | SummaryRecord
    | EditRecord
    | SupersedeRecord
    | RedactRecord
    | EpochResetRecord;

// ---------------- 存储页 ----------------

export interface EventPage {
    pageNo: number;
    seqStart: number;
    seqEnd: number;
    bytes: number;
    events: ConversationEvent[];
}

export interface RecordPage {
    pageNo: number;
    bytes: number;
    entries: RecordEntry[];
}

// ---------------- eventId 生成 ----------------

/** 用户消息：msgId 稳定优先；缺失时用调用方提供的兜底 key（迁移要确定性） */
export function userEventId(msgId: string, fallback: string): string {
    return msgId ? `u:${msgId}` : fallback;
}

export function assistantEventId(msgId: string, fallback: string): string {
    return msgId ? `a:${msgId}` : fallback;
}

export function toolCallEventId(groupId: string, callId: string): string {
    return `tc:${groupId}:${callId}`;
}

export function toolResultEventId(groupId: string, callId: string): string {
    return `tr:${groupId}:${callId}`;
}

export function systemEventId(dedupKey: string, fallback: string): string {
    return dedupKey ? `e:${dedupKey}` : fallback;
}

/** 调用方在无稳定 id 时的兜底（迁移必须确定性；运行时可用 seq 前的临时 key） */
export function fallbackEventId(kind: string, key: string | number): string {
    return `x:${kind}:${String(key)}`;
}
