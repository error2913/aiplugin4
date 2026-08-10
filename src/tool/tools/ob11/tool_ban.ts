// 禁言工具：禁言/全员禁言/禁言列表
import { getGroupMemberInfo, getGroupShutList, netExists, setGroupBan, setGroupWholeBan } from "../../../utils/ob11";
import { fmtDate } from "../../../utils/string";
import Tool from "../../tool";

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
                        description: '用户名称或纯数字QQ号'
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
    toolBan.sessionType = 'group';
    toolBan.sensitive = true; // 禁言属敏感操作
    toolBan.solve = async (ctx, _, session, args) => {
        const { name, duration } = args;

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;
        const gid = ctx.group!.groupId;
        const ui = await session.context.findUser(ctx, name);

        if (ui === null) return `未找到<${name}>`;
        const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
        if (!memberInfo) return `获取权限信息失败`;
        if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return `你没有管理员权限`;

        const memberInfo2 = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), ui.userId.replace(/^.+:/, ''));
        if (!memberInfo2) return `获取用户 ${ui.userId} 信息失败`;
        if (memberInfo2.role === 'owner') return `你无法禁言群主`;
        if (memberInfo2.role === 'admin' && memberInfo.role !== 'owner') return `你无法禁言管理员，因为你不是群主`;

        await setGroupBan(epId, gid.replace(/^.+:/, ''), ui.userId.replace(/^.+:/, ''), duration);
        return `已禁言<${name}> ${duration}秒`;
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
    toolWhole.sessionType = 'group';
    toolWhole.sensitive = true; // 全员禁言属敏感操作
    toolWhole.solve = async (ctx, _, __, args) => {
        const { enable } = args;

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;
        const gid = ctx.group!.groupId;

        await setGroupWholeBan(epId, gid.replace(/^.+:/, ''), enable);
        return `已${enable ? '开启' : '关闭'}全员禁言`;
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
    toolList.sessionType = 'group';
    toolList.solve = async (ctx, _, __, ___) => {
        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;
        const gid = ctx.group!.groupId;

        const groupShutList = await getGroupShutList(epId, gid.replace(/^.+:/, ''));
        if (!groupShutList || !Array.isArray(groupShutList)) return `获取禁言列表失败`;

        const s = `被禁言成员数量: ${groupShutList.length}\n` +
            groupShutList.slice(0, 50)
                .map((item: any, index: number) => `${index + 1}. ${item.nick}(${item.uin}) ${item.cardName && item.cardName !== item.nick ? `群名片: ${item.cardName}` : ''} 禁言结束时间: ${fmtDate(item.shutUpTime)}`)
                .join('\n');

        return s;
    }
}
