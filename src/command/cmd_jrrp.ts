import { getCtx, getMsg } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdJrrp() {
    const cmdJrrp = new Command('今日人品', 'jrrp');
    cmdJrrp.buildPrompt = () => {
        return '查看今日人品的指令:<$今日人品#被查看的人的名字>';
    }
    cmdJrrp.solve = (ctx, msg, cmdArgs, context, arg1) => {
        if (arg1) {
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
        }

        cmdJrrp.handleCmdArgs(cmdArgs);
        const ext = seal.ext.find('fun');
        ext.cmdMap['jrrp'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdJrrp);
}
