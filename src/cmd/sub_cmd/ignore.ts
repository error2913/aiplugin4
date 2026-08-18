// .ai ignore：群内忽略名单管理
import { normalizeUserId } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdIgnore() {
    const cmd = new SubCmd('ignore');
    cmd.desc = '忽略名单相关操作';
    cmd.help = `帮助:
  【.ai ign add <用户ID>】添加忽略名单
  【.ai ign rm <用户ID>】移除忽略名单
  【.ai ign lst】列出忽略名单
  
  忽略名单中的对象仍能正常对话，但不会被选为目标用户`;
    cmd.priv = {
        priv: U, args: {
            add: { priv: U },
            remove: { priv: U },
            list: { priv: U }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret  } = scc;

        if (ctx.isPrivate) {
            seal.replyToSender(ctx, msg, '忽略名单仅在群聊可用');
            return ret;
        }

        const val2 = cmdArgs.getArgN(2);
        const targetId = normalizeUserId(cmdArgs.getArgN(3));
        switch (aliasToCmd(val2)) {
            case 'add': {
                if (!targetId) {
                    seal.replyToSender(ctx, msg, '参数无效，【.ai ign add <用户ID>】添加忽略名单');
                    return ret;
                }
                if (session.context.ignoreList.includes(targetId!)) {
                    seal.replyToSender(ctx, msg, '已经在忽略名单中');
                    return ret;
                }
                session.context.ignoreList.push(targetId!);
                seal.replyToSender(ctx, msg, '已添加到忽略名单');
                session.save();
                return ret;
            }
            case 'remove': {
                if (!targetId) {
                    seal.replyToSender(ctx, msg, '参数无效，【.ai ign rm <用户ID>】移除忽略名单');
                    return ret;
                }
                if (!session.context.ignoreList.includes(targetId!)) {
                    seal.replyToSender(ctx, msg, '不在忽略名单中');
                    return ret;
                }
                session.context.ignoreList = session.context.ignoreList.filter(item => item !== targetId!);
                seal.replyToSender(ctx, msg, '已从忽略名单中移除');
                session.save();
                return ret;
            }
            case 'list': {
                const s = session.context.ignoreList.length === 0 ? '忽略名单为空' : `忽略名单如下:\n${session.context.ignoreList.join('\n')}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
  【.ai ign add <用户ID>】添加忽略名单
  【.ai ign rm <用户ID>】移除忽略名单
  【.ai ign lst】列出忽略名单
  
  忽略名单中的对象仍能正常对话，但不会被选为目标用户`);
                return ret;
            }
        }
    }
}
