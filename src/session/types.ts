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