// 改名工具：设置群名片
import { logger } from "../../../logger";
import Config from "../../../config/config";
import { getCtxAndMsg } from "../../../utils/seal";
import Tool from "../../tool";
import { getGroupMemberInfo, netExists } from "../../../utils/ob11";

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
                        description: '用户名称' + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '')
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
    tool.sessionType = 'group';
    tool.solve = async (ctx, msg, session, args) => {
        const { name, new_name } = args;

        if (netExists()) {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;

            const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
            if (!memberInfo) return `获取权限信息失败`;
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return `你没有管理员权限`;
        }

        const ui = await session.context.findUser(ctx, name);
        if (ui === null) return `未找到<${name}>`;

        ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ctx.group.groupId));

        try {
            seal.setPlayerGroupCard(ctx, new_name);
            if (session.context.autoNameMod === 2) {
                ctx.player.name = new_name;
            }
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${new_name}>`);
            return '设置成功';
        } catch (e) {
            logger.error(e);
            return '设置失败';
        }
    }
}
