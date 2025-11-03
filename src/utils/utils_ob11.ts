import { logger } from "../logger";

export function getNet() {
    const net = globalThis.net || globalThis.http;
    if (!net) {
        logger.error(`未找到ob11网络连接依赖`);
        return null;
    }
    return net;
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