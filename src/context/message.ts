// 消息结构工具：消息类型判断等静态方法
import Logger from "../logger";
import User from "../session/user";
import { fmtDate } from "../utils/string";
import { AssistantMessage, MessageType, RequestMessage, SystemUserMessageItem, ToolCallbackMessage, ToolCallsMessage, UserMessage, UserMessageItem } from "./types";

export default class Message {
    static getMessageType(m: MessageType): 'user' | 'assistant' | 'tool_calls' | 'tool_callback' {
        if (m.role === 'user') return 'user';
        else if (m.role === 'assistant') {
            if (m.hasOwnProperty('toolCalls')) return 'tool_calls';
            else return 'assistant';
        }
        else if (m.role === 'tool') return 'tool_callback';
        else throw new Error('Unknown message type');
    }

    static getUserMessageItemType(umi: UserMessageItem | SystemUserMessageItem): 'user' | 'system' {
        if (umi.hasOwnProperty('userId')) return 'user';
        else if (umi.hasOwnProperty('systemName')) return 'system';
        else throw new Error('Unknown message type');
    }

    static buildRequestMessages(messages: MessageType[]): RequestMessage[] { // 添加system message，sample message,增加前缀、时间等配置
        const res: RequestMessage[] = [];
        for (const m of messages) {
            switch (Message.getMessageType(m)) {
                case 'user': {
                    let currentUserId = '';
                    let content = "";
                    for (const umi of (m as UserMessage).contentItems) {
                        if (content.length > 0) content += '\\f';
                        if (Message.getUserMessageItemType(umi) == 'user') {
                            if ((umi as UserMessageItem).userId !== currentUserId) {
                                currentUserId = (umi as UserMessageItem).userId;
                                const u = User.get(currentUserId);
                                content += `<|from:${u.userName}(${u.userId})|>`;
                            }
                            content += `<|time:${fmtDate(umi.time)}|>`;
                            content += `<|msg_id:${(umi as UserMessageItem).messageId}|>`;
                        } else if (Message.getUserMessageItemType(umi) == 'system') {
                            content += `<|system:${(umi as SystemUserMessageItem).systemName}|>`;
                            content += `<|time:${fmtDate(umi.time)}|>`;
                        }
                        content += umi.text;
                    }
                    res.push({ role: 'user', content });
                    break;
                }
                case 'assistant': {
                    let content = "";
                    for (const ami of (m as AssistantMessage).contentItems) {
                        if (content.length > 0) content += '\\f';
                        content += `<|time:${fmtDate(ami.time)}|>`;
                        content += `<|msg_id:${(ami as UserMessageItem).messageId}|>`;
                        content += ami.text;
                    }
                    res.push({ role: 'assistant', content });
                    break;
                }
                case 'tool_calls': {
                    res.push({
                        role: 'assistant',
                        content: "",
                        tool_calls: (m as ToolCallsMessage).toolCalls
                    });
                    break;
                }
                case 'tool_callback': {
                    res.push({
                        role: 'tool',
                        content: (m as ToolCallbackMessage).text,
                        tool_call_id: (m as ToolCallbackMessage).toolCallId
                    });
                    break;
                }
                default: {
                    Logger.warning(`Unknown message type: ${Message.getMessageType(m)}`);
                }
            }
        }
        return res;
    }
}