// 列表工具：好友/群/成员/共同群搜索
import Config from "../../../config/config";
import { getFriendList, getGroupList, getGroupMemberList, netExists } from "../../../utils/ob11";
import Tool from "../../tool";

export function registerQQList() {
    const toolList = new Tool({
        type: "function",
        function: {
            name: "get_list",
            description: `查看当前好友列表或群聊列表`,
            parameters: {
                type: "object",
                properties: {
                    msg_type: {
                        type: "string",
                        description: "消息类型，私聊或群聊",
                        enum: ["private", "group"]
                    }
                },
                required: ["msg_type"]
            }
        }
    });
    toolList.solve = async (ctx, _, __, args) => {
        const { msg_type } = args;

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;

        if (msg_type === "private") {
            const friendList = await getFriendList(epId);
            if (!friendList || !Array.isArray(friendList)) return `获取好友列表失败`;

            const s = `好友数量: ${friendList.length}\n` + friendList.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
            }).join('\n');

            return s;
        } else if (msg_type === "group") {
            const groupList = await getGroupList(epId);
            if (!groupList || !Array.isArray(groupList)) return `获取群聊列表失败`;

            const s = `群聊数量: ${groupList.length}\n` + groupList.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
            }).join('\n');

            return s;
        } else {
            return `未知的消息类型<${msg_type}>`;
        }
    }

    const toolMember = new Tool({
        type: "function",
        function: {
            name: "get_group_member_list",
            description: `查看群聊成员列表`,
            parameters: {
                type: "object",
                properties: {
                    role: {
                        type: "string",
                        description: "成员角色，群主或管理员",
                        enum: ["owner", "admin", "robot"]
                    }
                },
                required: []
            }
        }
    });
    toolMember.solve = async (ctx, _, __, args) => {
        const { role = '' } = args;

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;
        const gid = ctx.group!.groupId;

        const groupMemberList = await getGroupMemberList(epId, gid.replace(/^.+:/, ''));
        if (!groupMemberList || !Array.isArray(groupMemberList)) return `获取群聊成员列表失败`;

        switch (role) {
            case 'owner': {
                const owner = groupMemberList.find((item: any) => item.role === role);
                if (!owner) return `未找到群主`;
                return `群主: ${owner.nickname}(${owner.user_id}) ${owner.card && owner.card !== owner.nickname ? `群名片: ${owner.card}` : ''}`;
            }
            case 'admin': {
                const admins = groupMemberList.filter((item: any) => item.role === role);
                if (admins.length === 0) return `未找到管理员`;
                const s = `管理员数量: ${admins.length}\n` +
                    admins.slice(0, 50)
                        .map((item: any, index: number) => `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`)
                        .join('\n');
                return s;
            }
            case 'robot': {
                const robots = groupMemberList.filter((item: any) => item.is_robot);
                if (robots.length === 0) return `未找到机器人`;
                const s = `机器人数量: ${robots.length}\n` +
                    robots.slice(0, 50)
                        .map((item: any, index: number) => `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`)
                        .join('\n');
                return s;
            }
            default: {
                const s = `群成员数量: ${groupMemberList.length}\n` +
                    groupMemberList.slice(0, 50)
                        .map((item: any, index: number) => `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''} ${item.title ? `头衔: ${item.title}` : ''} ${item.role === 'owner' ? '【群主】' : item.role === 'admin' ? '【管理员】' : item.is_robot ? '【机器人】' : ''}`)
                        .join('\n');
                return s;
            }
        }
    }

    const toolChat = new Tool({
        type: "function",
        function: {
            name: "search_chat",
            description: `搜索好友或群聊`,
            parameters: {
                type: "object",
                properties: {
                    msg_type: {
                        type: "string",
                        description: "消息类型，私聊或群聊",
                        enum: ["private", "group"]
                    },
                    q: {
                        type: 'string',
                        description: '搜索关键字'
                    }
                },
                required: ["q"]
            }
        }
    });
    toolChat.solve = async (ctx, _, __, args) => {
        const { msg_type, q } = args;

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;

        if (msg_type === "private") {
            const friendList = await getFriendList(epId);
            if (!friendList || !Array.isArray(friendList)) return `获取好友列表失败`;
            const arr = friendList.filter((item: any) => item.nickname.includes(q) || item.remark.includes(q));

            const s = `搜索结果好友数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
            }).join('\n');

            return s;
        } else if (msg_type === "group") {
            const groupList = await getGroupList(epId);
            if (!groupList || !Array.isArray(groupList)) return `获取群聊列表失败`;
            const arr = groupList.filter((item: any) => item.group_name.includes(q));

            const s = `搜索结果群聊数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
            }).join('\n');

            return s;
        } else {
            const friendList = await getFriendList(epId);
            if (!friendList || !Array.isArray(friendList)) return `获取好友列表失败`;
            const arr1 = friendList.filter((item: any) => item.nickname.includes(q) || item.remark.includes(q));

            const groupList = await getGroupList(epId);
            if (!groupList || !Array.isArray(groupList)) return `获取群聊列表失败`;
            const arr2 = groupList.filter((item: any) => item.group_name.includes(q));

            const s = `搜索结果好友数量: ${arr1.length}\n` + arr1.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
            }).join('\n') + `\n搜索结果群聊数量: ${arr2.length}\n` + arr2.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
            }).join('\n');

            return s;
        }
    }

    const toolCommon = new Tool({
        type: "function",
        function: {
            name: "search_common_group",
            description: `搜索共同群聊`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '')
                    }
                },
                required: ["name"]
            }
        }
    });
    toolCommon.solve = async (ctx, _, session, args) => {
        const { name } = args;

        const ui = await session.context.findUser(ctx, name, true);
        if (ui === null)   return `未找到<${name}>`;
        if (ui.userId === ctx.endPoint.userId)  return `禁止搜索自己`;

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;

        const groupList = await getGroupList(epId);
        if (!groupList || !Array.isArray(groupList)) return `获取群聊列表失败`;

        const arr = [];
        for (const group_info of groupList) {
            const groupMemberList = await getGroupMemberList(epId, group_info.group_id);
            if (!groupMemberList || !Array.isArray(groupMemberList)) continue;
            const user_info = groupMemberList.find((user_info: any) => user_info.user_id.toString() === ui.userId.replace(/^.+:/, ''));
            if (user_info) arr.push({ group_info, user_info });
        }

        const s = `共群数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
            return `${index + 1}. ${item.group_info.group_name}(${item.group_info.group_id}) 人数: ${item.group_info.member_count}/${item.group_info.max_member_count} ${item.user_info.card && item.user_info.card !== item.user_info.nickname ? `群名片: ${item.user_info.card}` : ''}`;
        }).join('\n');

        return s;
    }
}