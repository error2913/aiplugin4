// .ai steer：在不打断对话的前提下，向工具链插入方向提示
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdSteer() {
    const cmd = new SubCmd('steer');
    cmd.desc = '向当前对话插入方向提示';
    cmd.help = `帮助:
【.ai steer <内容>】不打断当前对话，把内容作为方向提示插入工具链，下一轮模型请求生效`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;

        const text = cmdArgs.getRestArgsFrom(2).trim();
        if (!text) {
            seal.replyToSender(ctx, msg, '【.ai steer <内容>】不打断当前对话，向工具链插入方向提示\n缺少内容');
            return ret;
        }
        if (!session.running) {
            seal.replyToSender(ctx, msg, '当前没有正在进行的对话');
            return ret;
        }
        session.steer(text);
        seal.replyToSender(ctx, msg, '已插入方向提示，将在下一轮生效');
        return ret;
    }
}
