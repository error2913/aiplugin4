import { getCtx, getMsg } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdBan() {
    const cmdBan = new Command('禁言');
    cmdBan.buildPrompt = () => {
        return '禁言别人的命令:<$禁言#被禁言者的名字#要设置的禁言秒数>';
    }
    cmdBan.solve = (ctx, msg, _, context, arg1, arg2) => {
        const extHttp = seal.ext.find('HTTP依赖');
        if (!extHttp) {
            console.error(`未找到HTTP依赖`);
            return;
        }

        if (!arg1) {
            console.error(`禁言需要一个名字`);
            return;
        }

        if (arg2) {
            const uid = context.findUid(arg1);
            if (uid === null) {
                console.error(`未找到<${arg1}>`);
                return;
            }

            msg = getMsg(msg.messageType, uid, ctx.group.groupId);
            ctx = getCtx(ctx.endPoint.userId, msg);

            if (uid === ctx.endPoint.userId) {
                ctx.player.name = arg1;
            }
        } else {
            arg2 = '2400';
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            const user_id = ctx.player.userId.replace(/\D+/g, '');
            globalThis.http.getData(epId, `set_group_ban?group_id=${group_id}&user_id=${user_id}&duration=${arg2}`);
        } catch (e) {
            console.error(e);
        }
    }
    CommandManager.registerCommand(cmdBan);
}