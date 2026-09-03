// 上下文消息类型定义
import { ToolCall, ToolContentPart } from "../tool/types";

export interface BaseMessageItem {
    time: number; // 秒
    text: string;
}

/** 合并压缩块内的一条原始用户消息（rawItems 条目） */
export interface RawUserItem {
    userId: string;
    messageId: string;
    time: number;
    /** 该条被压缩前的原文（含单条压缩时的 rawText 兜底） */
    text: string;
}

export interface UserMessageItem extends BaseMessageItem {
    userId: string;
    messageId: string;
    /** 单条消息被压缩前的完整原文：不参与渲染与 token 估算，仅由 read_raw/grep_raw(kind=user) 按需读取；随消息归档/清理失效 */
    rawText?: string;
    /** 连续多条 user 消息合并压缩后，块内各条原始消息（含各自 messageId/time）；块寻址 id 为 blk:<末条messageId> */
    rawItems?: RawUserItem[];
}
export interface AssistantMessageItem extends BaseMessageItem {
    messageId: string;
    reasoningContent?: string; // 思维链：thinking mode 下 assistant 消息必须原样回传
}
export interface SystemUserMessageItem extends BaseMessageItem {
    systemName: string; // 系统用户消息的名义
    /** 事件类型（仅事件提示词条目）：供 get_event_detail 过滤，不参与上下文渲染 */
    eventType?: string;
    /** 事件原始数据（仅事件提示词条目）：不渲染给模型，仅由工具读取；随消息清理/裁剪/遗忘一起失效 */
    raw?: unknown;
}

export interface UserMessage {
    role: 'user';
    contentItems: (UserMessageItem | SystemUserMessageItem)[];
}
export interface AssistantMessage {
    role: 'assistant';
    contentItems: AssistantMessageItem[];
}
export interface ToolCallsMessage {
    role: 'assistant';
    toolCalls: ToolCall[];
    reasoningContent?: string; // 思维链：该轮模型调用工具前的思考内容
}
export interface ToolCallbackMessage {
    role: 'tool';
    text: string;
    /** 截断前的完整工具返回：不参与渲染与 token 估算，仅由 grep_raw/read_raw(kind=tool) 按需读取；随所在消息清理/归档失效 */
    rawText?: string;
    contentParts?: ToolContentPart[];
    toolCallId: string;
    toolName?: string; // 工具名：prompt 工程模式下把工具结果转回 user 消息时保留来源
}

export type MessageType = UserMessage | AssistantMessage | ToolCallsMessage | ToolCallbackMessage;

export interface RequestMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string; // 思维链（DeepSeek thinking mode 回传要求）
}
