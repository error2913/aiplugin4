// .ai forget：遗忘（清除）上下文
import { aliasToCmd } from "../../utils/utils";
import { I, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdForget() {
    const cmd = new SubCmd('forget');
    cmd.desc = '遗忘上下文';
    cmd.help = `帮助:
【.ai forget】清除全部上下文
【.ai forget user】仅清除用户消息
【.ai forget assistant】清除 AI 回复与工具调用记录`;
    cmd.priv = {
        priv: I, args: {
            assistant: { priv: U },
            user: { priv: U }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret  } = scc;

        session.resetState();

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'assistant': {
                session.context.clearMessages('assistant', 'tool');
                seal.replyToSender(ctx, msg, 'ai上下文已清除');
                session.save();
                return ret;
            }
            case 'user': {
                session.context.clearMessages('user');
                seal.replyToSender(ctx, msg, '用户上下文已清除');
                session.save();
                return ret;
            }
            default: {
                session.context.clearMessages();
                seal.replyToSender(ctx, msg, '上下文已清除');
                session.save();
                return ret;
            }
        }
    }
}
