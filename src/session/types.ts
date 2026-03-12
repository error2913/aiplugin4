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
    tip: string;
}

export interface ToolCallsMessageItem extends BaseMessageItem {
    tool_calls: ToolCall[];
}

export interface ToolCallbackMessageItem extends BaseMessageItem {
    tool_call_id: string;
}

export type MessageItem = UserMessageItem | AssistantMessageItem | SystemUserMessageItem | ToolCallsMessageItem | ToolCallbackMessageItem;

export interface State {
    description: string; // 自定义描述
    impression: string; // ai可修改的印象
    [key: string]: any;
}

export interface RequestMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export type SessionType = 'user' | 'group';