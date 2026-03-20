import Logger from "../logger";
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

    static buildRequestMessages(messages: MessageType[]): RequestMessage[] { // 添加system message，对content进行模板处理 wip
        const res: RequestMessage[] = [];
        for (const m of messages) {
            switch (Message.getMessageType(m)) {
                case 'user': {
                    let content = "";
                    for (const umi of (m as UserMessage).contentItems) {
                        if (Message.getUserMessageItemType(umi) == 'user') {
                            content += umi.text;
                        } else if (Message.getUserMessageItemType(umi) == 'system') {
                            content += umi.text;
                        }
                    }
                    res.push({ role: 'user', content });
                    break;
                }
                case 'assistant': {
                    let content = "";
                    for (const ami of (m as AssistantMessage).contentItems) {
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