// 上下文消息类型定义
import { ToolCall, ToolContentPart } from "../tool/types";

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
    reasoningContent?: string; // 思维链：thinking mode 下 assistant 消息必须原样回传
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
    reasoningContent?: string; // 思维链：该轮模型调用工具前的思考内容
}
export interface ToolCallbackMessage {
    role: 'tool';
    text: string;
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