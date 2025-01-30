import { AIManager } from "../AI/AI";
import { getMsg, getCtx } from "../utils/utils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdMemory() {
    const cmdStShow = new Command('记忆');
    cmdStShow.buildPrompt = () => {
        return '添加记忆或者留下对别人印象的指令:<$记忆#被记忆者的名字#记忆的内容>';
    }
    cmdStShow.solve = (ctx, msg, __, context, arg1, arg2) => {
        if (!arg1) {
            console.error(`添加记忆需要一个名字`);
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
                console.error('不能添加自己的记忆');
                return;
            }

            //记忆相关处理
            const ai = AIManager.getAI(uid);
            ai.context.addMemory(ctx.group.groupName, arg2);
            AIManager.saveAI(uid);
        } else {
            console.error(`添加记忆需要一个内容`);
            return;
        }
    }
    CommandManager.registerCommand(cmdStShow);
}