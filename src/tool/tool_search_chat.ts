import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerSearchChat() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { msg_type, q } = args;

        if (msg_type === "private") {
            try {
                const epId = ctx.endPoint.userId;
                const data = await globalThis.http.getData(epId, `get_friend_list`);

                const arr = data.filter((item: any) => {
                    return item.nickname.includes(q) || item.remark.includes(q);
                });

                const s = `搜索结果好友数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
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

                const arr = data.filter((item: any) => {
                    return item.group_name.includes(q);
                });

                const s = `搜索结果群聊数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                    return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
                }).join('\n');

                return s;
            } catch (e) {
                console.error(e);
                return `获取好友列表失败`;
            }
        } else {
            const epId = ctx.endPoint.userId;

            const data1 = await globalThis.http.getData(epId, `get_friend_list`);
            const arr1 = data1.filter((item: any) => {
                return item.nickname.includes(q) || item.remark.includes(q);
            });

            const data2 = await globalThis.http.getData(epId, `get_group_list`);
            const arr2 = data2.filter((item: any) => {
                return item.group_name.includes(q);
            });

            const s = `搜索结果好友数量: ${arr1.length}\n` + arr1.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.remark && item.remark !== item.nickname ? `备注: ${item.remark}` : ''}`;
            }).join('\n') + `\n搜索结果群聊数量: ${arr2.length}\n` + arr2.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_name}(${item.group_id}) 人数: ${item.member_count}/${item.max_member_count}`;
            }).join('\n');

            return s;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerSearchCommonGroup() {
    const info: ToolInfo = {
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
                    },
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
        const { name } = args;

        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
            return `未找到<${name}>`;
        }
        if (uid === ctx.endPoint.userId) {
            return `禁止搜索自己`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const data = await globalThis.http.getData(epId, `get_group_list`);

            const arr = [];
            for (const group_info of data) {
                const data = await globalThis.http.getData(epId, `get_group_member_list?group_id=${group_info.group_id}`);
                const user_info = data.find((user_info: any) => user_info.user_id.toString() === uid.replace(/\D+/g, ''));
                if (user_info) {
                    arr.push({ group_info, user_info });
                }
            }

            const s = `共群数量: ${arr.length}\n` + arr.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.group_info.group_name}(${item.group_info.group_id}) 人数: ${item.group_info.member_count}/${item.group_info.max_member_count} ${item.user_info.card && item.user_info.card !== item.user_info.nickname ? `群名片: ${item.user_info.card}` : ''}`;
            }).join('\n');

            return s;
        } catch (e) {
            console.error(e);
            return `获取共群列表失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}