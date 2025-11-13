import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool } from "./tool";
import { getGroupMemberInfo, netExists } from "../utils/utils_ob11";

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

        if (netExists()) {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;

            const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
            if (!memberInfo) return { content: `获取权限信息失败`, images: [] };
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return { content: `你没有管理员权限`, images: [] };
        }

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) return { content: `未找到<${name}>`, images: [] };

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        try {
            seal.setPlayerGroupCard(ctx, new_name);
            if (ai.context.autoNameMod === 2) {
                ctx.player.name = new_name;
                ai.context.messages.forEach(message => message.name = message.uid === uid ? new_name : message.name);
            }
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${new_name}>`);
            return { content: '设置成功', images: [] };
        } catch (e) {
            logger.error(e);
            return { content: '设置失败', images: [] };
        }
    }
}