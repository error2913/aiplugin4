import { getMsg, getCtx } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdSt() {
    const cmdStShow = new Command('展示', 'st', 'show');
    cmdStShow.buildPrompt = () => {
        return '展示属性的指令:<$展示#被展示者的名字>';
    }
    cmdStShow.solve = (ctx, msg, cmdArgs, context, arg1) => {
        if (arg1) {
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
        }
        
        cmdStShow.handleCmdArgs(cmdArgs);
        const ext = seal.ext.find('coc7');
        ext.cmdMap['st'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdStShow);
}
