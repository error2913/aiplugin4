import { getCtx, getMsg } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdPoke() {
    const cmdPoke = new Command('戳');
    cmdPoke.buildPrompt = () => {
        return '戳戳别人的命令:<$戳#被戳的名字>';
    }
    cmdPoke.solve = (ctx, msg, _, context, arg1) => {
        const extHttp = seal.ext.find('HTTP依赖');
        if (!extHttp) {
            console.error(`未找到HTTP依赖`);
            return;
        }

        if (!arg1) {
            console.error(`戳戳需要一个名字`);
            return;
        }

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

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            const user_id = ctx.player.userId.replace(/\D+/g, '');
            globalThis.http.getData(epId, `group_poke?group_id=${group_id}&user_id=${user_id}`);
        } catch (e) {
            console.error(e);
        }
    }
    CommandManager.registerCommand(cmdPoke);
}
