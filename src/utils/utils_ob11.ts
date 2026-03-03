import { logger } from "../logger";
import { MessageSegment } from "./utils_string";

export function getNet() {
    const net = globalThis.net || globalThis.http;
    if (!net) {
        logger.warning(`未找到ob11网络连接依赖`);
        return null;
    }
    return net;
}

export function netExists(): boolean {
    const net = globalThis.net || globalThis.http;
    return net !== null && net !== undefined;
}

export async function sendPrivateMsg(epId: string, user_id: string, message: MessageSegment[]): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'send_private_msg', {
            user_id,
            message
        })
        return data;
    } catch (e) {
        logger.error(`发送私聊消息失败`);
        return null;
    }
}

export async function sendGroupMsg(epId: string, group_id: string, message: MessageSegment[]): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'send_group_msg', {
            group_id,
            message
        })
        return data;
    } catch (e) {
        logger.error(`发送群聊消息失败`);
        return null;
    }
}

export async function getStrangerInfo(epId: string, user_id: string): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_stranger_info', {
            user_id,
            no_cache: true
        })
        return data;
    } catch (e) {
        logger.error(`获取用户 ${user_id} 信息失败：${e}`);
        return null;
    }
}

export async function getGroupMemberInfo(epId: string, group_id: string, user_id: string): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_group_member_info', {
            group_id,
            user_id,
            no_cache: true
        })
        return data;
    } catch (e) {
        logger.error(`获取群 ${group_id} 用户 ${user_id} 信息失败：${e}`);
        return null;
    }
}

export async function getGroupMemberList(epId: string, group_id: string): Promise<any[]> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_group_member_list', {
            group_id,
            no_cache: true
        })
        return data;
    } catch (e) {
        logger.error(`获取群 ${group_id} 成员列表失败：${e}`);
        return null;
    }
}

export async function getFriendList(epId: string): Promise<any[]> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_friend_list');
        return data;
    } catch (e) {
        logger.error(`获取好友列表失败：${e}`);
        return null;
    }
}

export async function getGroupList(epId: string): Promise<any[]> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_group_list');
        return data;
    } catch (e) {
        logger.error(`获取群列表失败：${e}`);
        return null;
    }
}

export async function setGroupBan(epId: string, group_id: string, user_id: string, duration: number = 0): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, 'set_group_ban', {
            group_id,
            user_id,
            duration
        })
    } catch (e) {
        logger.error(`设置群 ${group_id} 用户 ${user_id} 禁言失败：${e}`);
        return;
    }
}

export async function setGroupWholeBan(epId: string, group_id: string, enable: boolean): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, 'set_group_whole_ban', {
            group_id,
            enable
        })
    } catch (e) {
        logger.error(`设置群 ${group_id} 全员禁言失败：${e}`);
        return;
    }
}

export async function getGroupShutList(epId: string, group_id: string): Promise<any[]> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_group_shut_list', {
            group_id,
            no_cache: true
        })
        return data;
    } catch (e) {
        logger.error(`获取群 ${group_id} 关闭列表失败：${e}`);
        return null;
    }
}

export async function setEssenceMsg(epId: string, message_id: number): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, 'set_essence_msg', {
            message_id
        })
    } catch (e) {
        logger.error(`设置消息 ${message_id} 精华消息失败：${e}`);
        return;
    }
}

export async function getEssenceMsgList(epId: string, group_id: string): Promise<any[]> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_essence_msg_list', {
            group_id,
            no_cache: true
        })
        return data;
    } catch (e) {
        logger.error(`获取群 ${group_id} 精华消息列表失败：${e}`);
        return null;
    }
}

export async function deleteEssenceMsg(epId: string, message_id: number): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, 'delete_essence_msg', {
            message_id
        })
    } catch (e) {
        logger.error(`删除消息 ${message_id} 精华消息失败：${e}`);
        return;
    }
}

export async function sendGroupSign(epId: string, group_id: string): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, 'send_group_sign', {
            group_id
        });
    } catch (e) {
        logger.error(`发送群 ${group_id} 签名失败：${e}`);
        return;
    }
}

export async function getMsg(epId: string, message_id: number): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'get_msg', {
            message_id
        })
        return data;
    } catch (e) {
        logger.error(`获取消息 ${message_id} 失败：${e}`);
        return null;
    }
}

export async function deleteMsg(epId: string, message_id: number): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, 'delete_msg', {
            message_id
        })
    } catch (e) {
        logger.error(`删除消息 ${message_id} 失败：${e}`);
        return;
    }
}

export async function sendGroupAISound(epId: string, characterId: string, group_id: string, text: string): Promise<void> {
    const net = getNet();
    if (!net) return;
    try {
        await net.callApi(epId, `send_group_ai_record?character=${characterId}&group_id=${group_id}&text=${text}`);
    } catch (e) {
        logger.error(`发送群 ${group_id} AI 声聊合成语音失败：${e}`);
        return;
    }
}

export async function sendPrivateForwardMsg(epId: string, user_id: string,
    messages: MessageSegment[],
    news: string[],
    prompt: string,
    summary: string,
    source: string): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'send_private_forward_msg', {
            user_id,
            messages,
            news,
            prompt,
            summary,
            source
        })
        return data;
    } catch (e) {
        logger.error(`发送用户 ${user_id} 转发消息失败：${e}`);
        return null;
    }
}

export async function sendGroupForwardMsg(epId: string, group_id: string,
    messages: MessageSegment[],
    news: string[],
    prompt: string,
    summary: string,
    source: string): Promise<any> {
    const net = getNet();
    if (!net) return null;
    try {
        const data = await net.callApi(epId, 'send_group_forward_msg', {
            group_id,
            messages,
            news,
            prompt,
            summary,
            source
        })
        return data;
    } catch (e) {
        logger.error(`发送群 ${group_id} 转发消息失败：${e}`);
        return null;
    }
}
