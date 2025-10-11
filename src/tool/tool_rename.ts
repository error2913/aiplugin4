import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool } from "./tool";

export function registerRename() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "rename",
            description: `设置群名片`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    new_name: {
                        type: 'string',
                        description: "新的名字"
                    }
                },
                required: ['name', 'new_name']
            }
        }
    });
    tool.type = 'group';
    tool.solve = async (ctx, msg, ai, args) => {
        const { name, new_name } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (ext) {
            try {
                const epId = ctx.endPoint.userId;
                const group_id = ctx.group.groupId.replace(/^.+:/, '');
                const user_id = epId.replace(/^.+:/, '');
                const result = await globalThis.http.getData(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
                if (result.role !== 'owner' && result.role !== 'admin') {
                    return `你没有管理员权限`;
                }
            } catch (e) {
                logger.error(e);
                return `获取权限信息失败`;
            }
        }

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        try {
            seal.setPlayerGroupCard(ctx, new_name);
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${new_name}>`);
            return '设置成功';
        } catch (e) {
            logger.error(e);
            return '设置失败';
        }
    }
}