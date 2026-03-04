import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdShut() {
    const cmd = new SubCmd('shut');
    cmd.desc = '打断当前对话';
    cmd.help = '';
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ai, ret } = scc;

        if (ai.stream.id === '') {
            seal.replyToSender(ctx, msg, '当前没有正在进行的对话');
            return ret;
        }

        await ai.stopCurrentChatStream()
        seal.replyToSender(ctx, msg, '已停止当前对话');
        return ret;
    }
}