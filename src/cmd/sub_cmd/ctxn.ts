// .ai ctxn：上下文内名字自动修改相关
import { logger } from "../../logger";
import { aliasToCmd } from "../../utils/utils";
import { I, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdCtxn() {
    const cmd = new SubCmd('ctxn');
    cmd.desc = '上下文里的名字相关';
    cmd.help = `帮助:
【.ai ctxn status】查看上下文里的名字和自动修改状态
【.ai ctxn set [nick/card]】设置上下文里的名字为昵称/群名片
【.ai ctxn mod <数字>】自动修改上下文里的名字(只在第一次出现时修改)
0: 不自动修改
1: 自动修改为昵称
2: 自动修改为群名片`;
    cmd.priv = {
        priv: U, args: {
            status: { priv: U },
            set: { priv: I },
            mod: { priv: I }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, epId, gid, session, ret  } = scc;
        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'status': {
                seal.replyToSender(ctx, msg, `自动修改上下文里的名字状态：${session.context.autoNameMod}
上下文里的名字有：\n${session.context.userInfoList.map(ui => `${ui.name}(${ui.id})`).join('\n')}`);
                return ret;
            }
            case 'set': {
                const val3 = cmdArgs.getArgN(3);
                const mod = aliasToCmd(val3);
                if (mod !== 'nickname' && mod !== 'card') {
                    seal.replyToSender(ctx, msg, `帮助:
【.ai ctxn set [nick/card]】设置上下文里的名字为昵称/群名片`);
                    return ret;
                }
                const promises = session.context.userInfoList.map(ui => session.context.setName(epId, gid, ui.id, mod));
                Promise.all(promises).then(() => {
                    seal.replyToSender(ctx, msg, `设置完成，上下文里的名字有：\n${session.context.userInfoList.map(uni => `${uni.name}(${uni.id})`).join('\n')}`);
                }).catch((e: any) => {
                    logger.error(`批量设置上下文名字出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
                    seal.replyToSender(ctx, msg, '批量设置名字失败，请查看日志');
                });
                return ret;
            }
            case 'mod': {
                const val3 = cmdArgs.getArgN(3);
                const mod = parseInt(val3);
                if (isNaN(mod) || mod < 0 || mod > 2) {
                    seal.replyToSender(ctx, msg, `帮助:
【.ai ctxn mod <数字>】自动修改上下文里的名字(只在第一次出现时修改)
0: 不自动修改
1: 自动修改为昵称
2: 自动修改为群名片`);
                    return ret;
                }
                session.context.autoNameMod = mod;
                session.save();
                const modText = mod === 0 ? '不自动修改' : (mod === 1 ? '自动修改为昵称' : '自动修改为群名片');
                seal.replyToSender(ctx, msg, `设置成功，${modText}`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, cmd.help);
                return ret;
            }
        }
    }
}
