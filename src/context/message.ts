// 消息结构工具：消息类型判断等静态方法
import { MessageType, SystemUserMessageItem, UserMessageItem } from "./types";

export default class Message {
    static getMessageType(m: MessageType | undefined | null): 'user' | 'assistant' | 'tool_calls' | 'tool_callback' {
        if (!m) return 'user';
        if (m.role === 'user') return 'user';
        else if (m.role === 'assistant') {
            if (Object.prototype.hasOwnProperty.call(m, 'toolCalls')) return 'tool_calls';
            else return 'assistant';
        }
        else if (m.role === 'tool') return 'tool_callback';
        else throw new Error('Unknown message type');
    }

    static getUserMessageItemType(umi: UserMessageItem | SystemUserMessageItem): 'user' | 'system' {
        if (Object.prototype.hasOwnProperty.call(umi, 'userId')) return 'user';
        else if (Object.prototype.hasOwnProperty.call(umi, 'systemName')) return 'system';
        else throw new Error('Unknown message type');
    }

}
