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
            if (uid !== null) {
                msg = getMsg(msg.messageType, uid, ctx.group.groupId);
                ctx = getCtx(ctx.endPoint.userId, msg);
            }
        }
        
        cmdStShow.handleCmdArgs(cmdArgs);
        const ext = seal.ext.find('coc7');
        ext.cmdMap['st'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdStShow);
}
