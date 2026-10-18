// .ai forget：遗忘（清除）上下文 / 清除原文分片
import { clearShardsFor } from "../../context/archive_store";
import { aliasToCmd } from "../../utils/utils";
import { I, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdForget() {
    const cmd = new SubCmd('forget');
    cmd.desc = '遗忘上下文';
    cmd.help = `帮助:
【.ai forget】清除全部上下文
【.ai forget user】仅清除用户消息
【.ai forget assistant】清除 AI 回复与工具调用记录
【.ai forget --all】清除本会话的归档/窗口移出原文分片（释放存储；已沉淀的长期记忆不受影响）`;
    cmd.priv = {
        priv: I, args: {
            assistant: { priv: U },
            user: { priv: U }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret  } = scc;

        // --all（别名 --raw）：清空本会话的 arc/raw 分片并重置水位。
        // 语义区分：分片是"原文留档"，.ai forget（不带 --all）只清上下文、不碰分片；
        // 长期记忆在 memv2:*，本命令同样不影响它（只是原文再也查不回来了）。
        if (cmdArgs.kwargs.some(k => k.name === 'all' || k.name === 'raw')) {
            const sid = session.sessionId;
            const arcSeq = (session as any).archiveSeq || 0;
            const rawSeq = (session as any).rawSeq || 0;
            const cleared = clearShardsFor(sid, 'arc', arcSeq) + clearShardsFor(sid, 'raw', rawSeq);
            (session as any).archiveSeq = 0;
            (session as any).rawSeq = 0;
            (session as any).settledSeq = 0;
            (session as any).lastArchivedAt = 0;
            (session as any).lastRawAt = 0;
            session.save();
            seal.replyToSender(ctx, msg, `已清除 ${cleared} 个原文分片（归档 ${arcSeq} + 窗口移出 ${rawSeq}）；已沉淀的长期记忆不受影响`);
            return ret;
        }

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
                session.resetState();
                session.context.clearMessages();
                seal.replyToSender(ctx, msg, '上下文已清除');
                session.save();
                return ret;
            }
        }
    }
}
