import { getMsg, getCtx } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdRa() {
    const cmdRa = new Command('检定', 'ra');
    cmdRa.buildPrompt = () => {
        return '进行检定的命令:<$检定#被检定人的名字#检定目的或技能名>';
    }
    cmdRa.solve = (ctx, msg, cmdArgs, context, arg1, arg2) => {
        if (!arg1) {
            console.error(`检定需要一个检定目的或技能名`);
            return;
        }

        if (arg2) {
            const uid = context.findUid(arg1);
            if (uid === null) {
                console.log(`未找到<${arg1}>`);
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

        const [v, _] = seal.vars.intGet(ctx, arg2);
        if (v == 0) {
            arg2 += '50';
        }

        cmdRa.handleCmdArgs(cmdArgs, arg2);
        const ext = seal.ext.find('coc7');
        ext.cmdMap['ra'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdRa);
}
