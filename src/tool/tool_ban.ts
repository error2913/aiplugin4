import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";
import { fmtDate } from "../utils/utils_string";
import { getGroupMemberInfo, getGroupShutList, netExists, setGroupBan, setGroupWholeBan } from "../utils/utils_ob11";

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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        const uid = await ai.context.findUserId(ctx, name);

        if (uid === null) return { content: `未找到<${name}>`, images: [] };
        const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
        if (!memberInfo) return { content: `获取权限信息失败`, images: [] };
        if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return { content: `你没有管理员权限`, images: [] };

        const memberInfo2 = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), uid.replace(/^.+:/, ''));
        if (!memberInfo2) return { content: `获取用户 ${uid} 信息失败`, images: [] };
        if (memberInfo2.role === 'owner' || memberInfo2.role === 'admin') return { content: `你无法禁言${memberInfo2.role === 'owner' ? '群主' : '管理员'}`, images: [] };

        await setGroupBan(epId, gid.replace(/^.+:/, ''), uid.replace(/^.+:/, ''), duration);
        return { content: `已禁言<${name}> ${duration}秒`, images: [] };
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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        await setGroupWholeBan(epId, gid.replace(/^.+:/, ''), enable);
        return { content: `已${enable ? '开启' : '关闭'}全员禁言`, images: [] };
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
        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        const groupShutList = await getGroupShutList(epId, gid.replace(/^.+:/, ''));
        if (!groupShutList || !Array.isArray(groupShutList)) return { content: `获取禁言列表失败`, images: [] };

        const s = `被禁言成员数量: ${groupShutList.length}\n` +
            groupShutList.slice(0, 50)
                .map((item: any, index: number) => `${index + 1}. ${item.nick}(${item.uin}) ${item.cardName && item.cardName !== item.nick ? `群名片: ${item.cardName}` : ''} 禁言结束时间: ${fmtDate(item.shutUpTime)}`)
                .join('\n');

        return { content: s, images: [] };
    }
}