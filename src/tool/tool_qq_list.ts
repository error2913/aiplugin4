import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { Tool } from "./tool";

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

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        if (msg_type === "private") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await net.callApi(epId, `get_friend_list`);

                const s = `好友数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
                }).join('\n');

                return { content: s, images: [] };
            } catch (e) {
                logger.error(e);
                return { content: `获取好友列表失败`, images: [] };
            }
        } else if (msg_type === "group") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await net.callApi(epId, `get_group_list`);

                const s = `群聊数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
                }).join('\n');

                return { content: s, images: [] };
            } catch (e) {
                logger.error(e);
                return { content: `获取好友列表失败`, images: [] };
            }
        } else {
            return { content: `未知的消息类型<${msg_type}>`, images: [] };
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

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;
            const data = await net.callApi(epId, `get_group_member_list?group_id=${gid.replace(/^.+:/, '')}`);

            if (role === 'owner') {
                const owner = data.find((item: any) => item.role === role);
                if (!owner) {
                    return { content: `未找到群主`, images: [] };
                }
                return { content: `群主: ${owner.nickname}(${owner.user_id}) ${owner.card && owner.card !== owner.nickname ? `群名片: ${owner.card}` : ''}`, images: [] };
            } else if (role === 'admin') {
                const admins = data.filter((item: any) => item.role === role);
                if (admins.length === 0) {
                    return { content: `未找到管理员`, images: [] };
                }
                const s = `管理员数量: ${admins.length}\n` + admins.slice(0, 50).map((item: any, index: number) => {
                    `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`;
                }).join('\n');
                return { content: s, images: [] };
            } else if (role === 'robot') {
                const robots = data.filter((item: any) => item.is_robot);
                if (robots.length === 0) {
                    return { content: `未找到机器人`, images: [] };
                }
                const s = `机器人数量: ${robots.length}\n` + robots.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`;
                }).join('\n');
                return { content: s, images: [] };
            }

            const s = `群成员数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''} ${item.title ? `头衔: ${item.title}` : ''} ${item.role === 'owner' ? '【群主】' : item.role === 'admin' ? '【管理员】' : item.is_robot ? '【机器人】' : ''}`;
            }).join('\n');
            return { content: s, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `获取群成员列表失败`, images: [] };
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

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        if (msg_type === "private") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await net.callApi(epId, `get_friend_list`);

                const arr = data.filter((item: any) => {
                    return item.nickname.includes(q) || item.remark.includes(q);
                });

                const s = `搜索结果好友数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
                }).join('\n');

                return { content: s, images: [] };
            } catch (e) {
                logger.error(e);
                return { content: `获取好友列表失败`, images: [] };
            }
        } else if (msg_type === "group") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await net.callApi(epId, `get_group_list`);

                const arr = data.filter((item: any) => {
                    return item.group_name.includes(q);
                });

                const s = `搜索结果群聊数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
                }).join('\n');

                return { content: s, images: [] };
            } catch (e) {
                logger.error(e);
                return { content: `获取好友列表失败`, images: [] };
            }
        } else {
            const epId = ctx.endPoint.userId;

            const data1 = await net.callApi(epId, `get_friend_list`);
            const arr1 = data1.filter((item: any) => {
                return item.nickname.includes(q) || item.remark.includes(q);
            });

            const data2 = await net.callApi(epId, `get_group_list`);
            const arr2 = data2.filter((item: any) => {
                return item.group_name.includes(q);
            });

            const s = `搜索结果好友数量: ${arr1.length}\n` + arr1.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
            }).join('\n') + `\n搜索结果群聊数量: ${arr2.length}\n` + arr2.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
            }).join('\n');

            return { content: s, images: [] };
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
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    }
                },
                required: ["name"]
            }
        }
    });
    toolCommon.solve = async (ctx, _, ai, args) => {
        const { name } = args;

        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
            return { content: `未找到<${name}>`, images: [] };
        }
        if (uid === ctx.endPoint.userId) {
            return { content: `禁止搜索自己`, images: [] };
        }

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const data = await net.callApi(epId, `get_group_list`);

            const arr = [];
            for (const group_info of data) {
                const data = await net.callApi(epId, `get_group_member_list?group_id=${group_info.group_id}`);
                const user_info = data.find((user_info: any) => user_info.user_id.toString() === uid.replace(/^.+:/, ''));
                if (user_info) {
                    arr.push({ group_info, user_info });
                }
            }

            const s = `共群数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_info.group_name}(${item.group_info.group_id}) 人数: ${item.group_info.member_count}/${item.group_info.max_member_count} ${item.user_info.card && item.user_info.card !== item.user_info.nickname ? `群名片: ${item.user_info.card}` : ''}`;
            }).join('\n');

            return { content: s, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `获取共群列表失败`, images: [] };
        }
    }
}