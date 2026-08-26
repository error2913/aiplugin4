// .ai stop：完全暂停当前对话（打断流式/工具链/排队/计时器，保留触发条件）
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdStop() {
    const cmd = new SubCmd('stop');
    cmd.desc = '完全暂停当前对话（打断流式/工具链/排队）';
    cmd.help = `帮助:
【.ai stop】完全暂停当前对话：打断流式输出、中断工具链、清掉排队请求与待触发计时器`;
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, session, ret } = scc;

        const { hadStream, hadRun, hadTimer, queueCleared } = await session.stopConversation();
        if (!hadStream && !hadRun && !hadTimer && queueCleared === 0) {
            seal.replyToSender(ctx, msg, '当前没有正在进行的对话');
            return ret;
        }

        const parts: string[] = [];
        if (hadStream) parts.push('已打断流式输出');
        if (hadRun) parts.push('已中断工具链');
        if (queueCleared > 0) parts.push(`已清理排队请求 ${queueCleared} 条`);
        if (hadTimer) parts.push('已清除待触发计时器');
        seal.replyToSender(ctx, msg, parts.join('，') + '，对话已完全暂停');
        return ret;
    }
}
