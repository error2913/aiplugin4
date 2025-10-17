import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { Tool } from "./tool";
import { fmtDate } from "../utils/utils_string";

export function registerBan() {
    const toolBan = new Tool({
        type: 'function',
        function: {
            name: 'ban',
            description: '禁言指定用户',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    duration: {
                        type: 'integer',
                        description: '禁言时长，单位为秒，最大为2591940'
                    }
                },
                required: ['name', 'duration']
            }
        }
    });
    toolBan.type = 'group';
    toolBan.solve = async (ctx, _, ai, args) => {
        const { name, duration } = args;

        if (ctx.isPrivate) {
            return { content: `该命令只能在群聊中使用`, images: [] };
        }

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return { content: `未找到<${name}>`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = epId.replace(/^.+:/, '');
            const result = await net.callApi(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
            if (result.role !== 'owner' && result.role !== 'admin') {
                return { content: `你没有管理员权限`, images: [] };
            }
        } catch (e) {
            logger.error(e);
            return { content: `获取权限信息失败`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = uid.replace(/^.+:/, '');
            const result = await net.callApi(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
            if (result.role === 'owner' || result.role === 'admin') {
                return { content: `你无法禁言${result.role === 'owner' ? '群主' : '管理员'}`, images: [] };
            }
        } catch (e) {
            logger.error(e);
            return { content: `获取权限信息失败`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = uid.replace(/^.+:/, '');
            await net.callApi(epId, `set_group_ban?group_id=${group_id}&user_id=${user_id}&duration=${duration}`);
            return { content: `已禁言<${name}> ${duration}秒`, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `禁言失败`, images: [] };
        }
    }

    const toolWhole = new Tool({
        type: 'function',
        function: {
            name: 'whole_ban',
            description: '全员禁言',
            parameters: {
                type: 'object',
                properties: {
                    enable: {
                        type: 'boolean',
                        description: '开启还是关闭全员禁言'
                    }
                },
                required: ['enable']
            }
        }
    });
    toolWhole.type = 'group';
    toolWhole.solve = async (ctx, _, __, args) => {
        const { enable } = args;

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;
            await net.callApi(epId, `set_group_whole_ban?group_id=${gid.replace(/^.+:/, '')}&enable=${enable}`);
            return { content: `已${enable ? '开启' : '关闭'}全员禁言`, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `全员禁言失败`, images: [] };
        }
    }

    const toolList = new Tool({
        type: 'function',
        function: {
            name: 'get_ban_list',
            description: '获取群内禁言列表',
            parameters: {
                type: 'object',
                properties: {
                },
                required: []
            }
        }
    });
    toolList.type = 'group';
    toolList.solve = async (ctx, _, __, ___) => {
        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;
            const data = await net.callApi(epId, `get_group_shut_list?group_id=${gid.replace(/^.+:/, '')}`);

            const s = `被禁言成员数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                return { content: `${index + 1}. ${item.nick}(${item.uin}) ${item.cardName && item.cardName !== item.nick ? `群名片: ${item.cardName}` : ''} 禁言结束时间: ${fmtDate(item.shutUpTime)}`, images: [] };
            }).join('\n');

            return { content: s, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `获取禁言列表失败`, images: [] };
        }
    }
}