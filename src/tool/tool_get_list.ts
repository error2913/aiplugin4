import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerGetList() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { msg_type } = args;

        if (msg_type === "private") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await globalThis.http.getData(epId, `get_friend_list`);

                const s = `好友数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
                }).join('\n');

                return s;
            } catch (e) {
                console.error(e);
                return `获取好友列表失败`;
            }
        } else if (msg_type === "group") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await globalThis.http.getData(epId, `get_group_list`);

                const s = `群聊数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
                }).join('\n');

                return s;
            } catch (e) {
                console.error(e);
                return `获取好友列表失败`;
            }
        } else {
            return `未知的消息类型<${msg_type}>`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerGetGroupMemberList() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { role = '' } = args;

        try {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;
            const data = await globalThis.http.getData(epId, `get_group_member_list?group_id=${gid.replace(/\D+/g, '')}`);

            if (role === 'owner') {
                const owner = data.find((item: any) => item.role === role);
                if (!owner) {
                    return `未找到群主`;
                }
                return `群主: ${owner.nickname}(${owner.user_id}) ${owner.card && owner.card !== owner.nickname ? `群名片: ${owner.card}` : ''}`;
            } else if (role === 'admin') {
                const admins = data.filter((item: any) => item.role === role);
                if (admins.length === 0) {
                    return `未找到管理员`;
                }
                const s = `管理员数量: ${admins.length}\n` + admins.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`;
                }).join('\n');
                return s;
            } else if (role === 'robot') {
                const robots = data.filter((item: any) => item.is_robot);
                if (robots.length === 0) {
                    return `未找到机器人`;
                }
                const s = `机器人数量: ${robots.length}\n` + robots.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`;
                }).join('\n');
                return s;
            }

            const s = `群成员数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''} ${item.role === 'owner' ? '【群主】' : item.role === 'admin' ? '【管理员】' : item.is_robot ? '【机器人】' : ''}`;
            }).join('\n');
            return s;
        } catch (e) {
            console.error(e);
            return `获取群成员列表失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}