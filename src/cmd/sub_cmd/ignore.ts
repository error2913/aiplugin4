import { AIManager } from "../../AI/AI";
import { aliasToCmd } from "../../utils/utils";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdIgnore() {
    const cmd = new SubCmd('ignore');
    cmd.desc = '忽略名单相关操作';
    cmd.help = '';
    cmd.priv = {
        priv: U, args: {
            add: { priv: U },
            remove: { priv: U },
            list: { priv: U }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, epId, sid, ai, ret } = scc;

        if (ctx.isPrivate) {
            seal.replyToSender(ctx, msg, '忽略名单仅在群聊可用');
            return ret;
        }

        const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
        const muid = cmdArgs.amIBeMentionedFirst ? epId : mctx.player.userId;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'add': {
                if (cmdArgs.at.length === 0) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai ign add @xxx】添加忽略名单');
                    return ret;
                }
                if (ai.context.ignoreList.includes(muid)) {
                    seal.replyToSender(ctx, msg, '已经在忽略名单中');
                    return ret;
                }
                ai.context.ignoreList.push(muid);
                seal.replyToSender(ctx, msg, '已添加到忽略名单');
                AIManager.saveAI(sid);
                return ret;
            }
            case 'remove': {
                if (cmdArgs.at.length === 0) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai ign rm @xxx】移除忽略名单');
                    return ret;
                }
                if (!ai.context.ignoreList.includes(muid)) {
                    seal.replyToSender(ctx, msg, '不在忽略名单中');
                    return ret;
                }
                ai.context.ignoreList = ai.context.ignoreList.filter(item => item !== muid);
                seal.replyToSender(ctx, msg, '已从忽略名单中移除');
                AIManager.saveAI(sid);
                return ret;
            }
            case 'list': {
                const s = ai.context.ignoreList.length === 0 ? '忽略名单为空' : `忽略名单如下:\n${ai.context.ignoreList.join('\n')}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
  【.ai ign add @xxx】添加忽略名单
  【.ai ign rm @xxx】移除忽略名单
  【.ai ign lst】列出忽略名单
  
  忽略名单中的对象仍能正常对话，但无法被选中QQ号`);
                return ret;
            }
        }
    }
}