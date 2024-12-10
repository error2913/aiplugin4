import { getCtx, getMsg } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdRename() {
    const cmdRename = new Command('改名');
    cmdRename.buildPrompt = () => {
        return '设置群名片的命令:<$改名#被改名者的名字#要设置的名字>';
    }
    cmdRename.solve = (ctx, msg, _, context, arg1, arg2) => {
        if (!arg1) {
            console.error(`改名需要一个名字`);
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
            arg2 = arg1;
        }

        try {
            seal.setPlayerGroupCard(ctx, arg2);
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${arg2}>`);
        } catch (e) {
            console.error(e);
        }
    }
    CommandManager.registerCommand(cmdRename);
}