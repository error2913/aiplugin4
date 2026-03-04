import { AIManager } from "../../AI/AI";
import { aliasToCmd } from "../../utils/utils";
import { I, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdForget() {
    const cmd = new SubCmd('forget');
    cmd.desc = '遗忘上下文';
    cmd.help = '';
    cmd.priv = {
        priv: I, args: {
            assistant: { priv: U },
            user: { priv: U }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, ai, ret } = scc;

        ai.resetState();

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'assistant': {
                ai.context.clearMessages('assistant', 'tool');
                seal.replyToSender(ctx, msg, 'ai上下文已清除');
                AIManager.saveAI(sid);
                return ret;
            }
            case 'user': {
                ai.context.clearMessages('user');
                seal.replyToSender(ctx, msg, '用户上下文已清除');
                AIManager.saveAI(sid);
                return ret;
            }
            default: {
                ai.context.clearMessages();
                seal.replyToSender(ctx, msg, '上下文已清除');
                AIManager.saveAI(sid);
                return ret;
            }
        }
    }
}