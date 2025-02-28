import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerCheckList() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "check_list",
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

export function registerCheckGroupMemberList() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "check_group_member_list",
            description: `查看群聊成员列表`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: '群聊名称' + (ConfigManager.message.showNumber ? '或纯数字群号' : '')
                    },
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
        const { name } = args;

        const gid = await ai.context.findGroupId(ctx, name);
        if (gid === null) {
            console.log(`未找到<${name}>`);
            return `未找到<${name}>`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const data = await globalThis.http.getData(epId, `get_group_member_list?group_id=${gid.replace(/\D+/g, '')}`);

            const s = `群成员数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nickname}(${item.user_id}) ${item.card && item.card !== item.nickname ? `群名片: ${item.card}` : ''}`;
            }).join('\n');

            return s;
        } catch (e) {
            console.error(e);
            return `获取群成员列表失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}