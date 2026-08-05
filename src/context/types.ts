// 上下文消息类型定义
import { ToolCall } from "../tool/types";

export interface BaseMessageItem {
    time: number; // 秒
    text: string;
}
export interface UserMessageItem extends BaseMessageItem {
    userId: string;
    messageId: string;
}
export interface AssistantMessageItem extends BaseMessageItem {
    messageId: string;
}
export interface SystemUserMessageItem extends BaseMessageItem {
    systemName: string; // 系统用户消息的名义
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
}
export interface ToolCallbackMessage {
    role: 'tool';
    text: string;
    toolCallId: string;
}

export type MessageType = UserMessage | AssistantMessage | ToolCallsMessage | ToolCallbackMessage;

export interface RequestMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}