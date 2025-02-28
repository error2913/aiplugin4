import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerBan() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { name, duration } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            console.log(`未找到<${name}>`);
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            const user_id = ctx.player.userId.replace(/\D+/g, '');
            await globalThis.http.getData(epId, `set_group_ban?group_id=${group_id}&user_id=${user_id}&duration=${duration}`);
            return `已禁言<${name}> ${duration}秒`;
        } catch (e) {
            console.error(e);
            return `禁言失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerWholeBan() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { enable } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;
            await globalThis.http.getData(epId, `set_group_whole_ban?group_id=${gid.replace(/\D+/g, '')}&enable=${enable}`);
            return `已${enable? '开启' : '关闭'}全员禁言`;
        } catch (e) {
            console.error(e);
            return `全员禁言失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerGetBanList() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, ___) => {
        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;
            const data = await globalThis.http.getData(epId, `get_group_shut_list?group_id=${gid.replace(/\D+/g, '')}`);

            const s = `被禁言成员数量: ${data.length}\n` + data.slice(0, 50).map((item: any, index: number) => {
                return `${index + 1}. ${item.nick}(${item.uin}) ${item.cardName && item.cardName !== item.nick ? `群名片: ${item.cardName}` : ''} 被禁言时间: ${new Date(item.shutUpTime * 1000).toLocaleString()}`;
            }).join('\n');

            return s;
        } catch (e) {
            console.error(e);
            return `获取禁言列表失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}