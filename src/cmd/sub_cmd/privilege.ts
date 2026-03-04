import { AIManager } from "../../AI/AI";
import { HELPMAP } from "../../config/config";
import { aliasToCmd } from "../../utils/utils";
import { M, PrivilegeManager, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdPrivilege() {
    const cmd = new SubCmd('privilege');
    cmd.desc = '权限相关';
    cmd.help = `帮助:
【.ai priv ses st <ID> <会话权限>】修改会话权限
【.ai priv ses ck <ID>】检查会话权限
【.ai priv st <指令> <权限限制>】修改指令权限
【.ai priv show <指令>】检查指令权限
【.ai priv reset】重置指令权限
${HELPMAP["ID"]}
${HELPMAP["会话权限"]}
${HELPMAP["指令"]}
${HELPMAP["权限限制"]}`;
    cmd.priv = {
        priv: M, args: {
            session: {
                priv: U, args: {
                    set: { priv: U },
                    check: { priv: U }
                }
            },
            set: { priv: U },
            show: { priv: U },
            reset: { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, ret } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'session': {
                const val3 = cmdArgs.getArgN(3);
                switch (aliasToCmd(val3)) {
                    case 'set': {
                        const val4 = cmdArgs.getArgN(4);
                        if (!val4 || val4 == 'help') {
                            seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses st <ID> <会话权限>】修改会话权限
${HELPMAP["ID"]}
${HELPMAP["会话权限"]}`);
                            return ret;
                        }

                        const val5 = cmdArgs.getArgN(5);
                        const limit = parseInt(val5);
                        if (isNaN(limit)) {
                            seal.replyToSender(ctx, msg, '权限值必须为数字');
                            return ret;
                        }

                        const id2 = val4 === 'now' ? sid : val4;
                        const ai2 = AIManager.getAI(id2);

                        ai2.setting.priv = limit;

                        seal.replyToSender(ctx, msg, '权限修改完成');
                        AIManager.saveAI(id2);
                        return ret;
                    }
                    case 'check': {
                        const val4 = cmdArgs.getArgN(4);
                        if (!val4 || val4 == 'help') {
                            seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses ck <ID>】检查会话权限
${HELPMAP["ID"]}`);
                            return ret;
                        }

                        const id2 = val4 === 'now' ? sid : val4;
                        const ai2 = AIManager.getAI(id2);
                        seal.replyToSender(ctx, msg, `${id2}\n会话权限:${ai2.setting.priv}`);
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, `帮助:
【.ai priv ses st <ID> <会话权限>】修改会话权限
【.ai priv ses ck <ID>】检查会话权限
${HELPMAP["ID"]}
${HELPMAP["会话权限"]}`);
                        return ret;
                    }
                }
            }
            case 'set': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3 || val3 == 'help') {
                    seal.replyToSender(ctx, msg, `帮助:
【.ai priv st <指令> <权限限制>】修改指令权限
${HELPMAP["指令"]}
${HELPMAP["权限限制"]}`);
                    return ret;
                }
                const cmdChain = val3.split('-').map(cmd => aliasToCmd(cmd));
                if (cmdChain?.[1] === 'privilege') {
                    seal.replyToSender(ctx, msg, `你不能修改priv指令的权限`);
                    return ret;
                }
                const cpi = PrivilegeManager.getCmdPrivInfo(cmdChain);
                if (!cpi) {
                    seal.replyToSender(ctx, msg, `指令${val3}不存在`);
                    return ret;
                }
                const val4 = cmdArgs.getArgN(4);
                const priv = val4.split('-').map(p => parseInt(p));
                if (priv.length !== 3) {
                    seal.replyToSender(ctx, msg, '权限值必须为3个数字');
                    return ret;
                }
                for (const p of priv) {
                    if (isNaN(p)) {
                        seal.replyToSender(ctx, msg, '权限值必须为数字');
                        return ret;
                    }
                }
                cpi.priv = priv as [number, number, number];
                PrivilegeManager.saveCmdPriv();
                seal.replyToSender(ctx, msg, '权限修改完成');
                return ret;
            }
            case 'show': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3 || val3 == 'help') {
                    seal.replyToSender(ctx, msg, `帮助:
【.ai priv show <指令>】检查指令权限
${HELPMAP["指令"]}`);
                    return ret;
                }
                const cmdChain = val3.split('-');
                const cpi = PrivilegeManager.getCmdPrivInfo(cmdChain);
                if (!cpi) {
                    seal.replyToSender(ctx, msg, `指令${val3}不存在`);
                    return ret;
                }
                seal.replyToSender(ctx, msg, `指令${val3}权限限制:${cpi.priv.join('-')}`);
                return ret;
            }
            case 'reset': {
                PrivilegeManager.resetCmdPriv();
                seal.replyToSender(ctx, msg, '指令权限重置完成');
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, cmd.help);
                return ret;
            }
        }
    }
}