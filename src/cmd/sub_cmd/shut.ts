// .ai shut：打断当前流式对话
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdShut() {
    const cmd = new SubCmd('shut');
    cmd.desc = '打断当前对话';
    cmd.help = '';
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, session, ret } = scc;

        if (session.stream.id === '') {
            seal.replyToSender(ctx, msg, '当前没有正在进行的对话');
            return ret;
        }

        await session.stopCurrentChatStream()
        seal.replyToSender(ctx, msg, '已停止当前对话');
        return ret;
    }
}
