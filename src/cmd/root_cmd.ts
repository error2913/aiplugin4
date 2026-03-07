import { AI, AIManager } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { CmdPrivInfo, defaultCmdPriv, PrivilegeManager, U } from "./privilege";
import { aliasToCmd } from "../utils/utils";
import { registerCmdPrivilege } from "./sub_cmd/privilege";
import { registerCmdPrompt } from "./sub_cmd/prompt";
import { registerCmdStatus } from "./sub_cmd/status";
import { registerCmdCtxn } from "./sub_cmd/ctxn";
import { registerCmdTimer } from "./sub_cmd/timer";
import { registerCmdOn } from "./sub_cmd/on";
import { registerCmdStandby } from "./sub_cmd/standby";
import { registerCmdOff } from "./sub_cmd/off";
import { registerCmdForget } from "./sub_cmd/forget";
import { registerCmdRole } from "./sub_cmd/role";
import { registerCmdImage } from "./sub_cmd/image";
import { registerCmdMemory } from "./sub_cmd/memory";
import { registerCmdTool } from "./sub_cmd/tool";
import { registerCmdIgnore } from "./sub_cmd/ignore";
import { registerCmdToken } from "./sub_cmd/token";
import { registerCmdShut } from "./sub_cmd/shut";

export interface SubCmdContext {
    ctx: seal.MsgContext;
    msg: seal.Message;
    cmdArgs: seal.CmdArgs;
    epId: string;
    uid: string;
    gid: string;
    sid: string;
    ai: AI;
    page: number;
    ret: seal.CmdExecuteResult;
}

export class SubCmd {
    name: string;
    desc: string;
    help: string;
    priv: CmdPrivInfo;
    solve: (scc: SubCmdContext) => seal.CmdExecuteResult | Promise<seal.CmdExecuteResult>;

    constructor(name: string) {
        this.name = name;
        this.desc = '';
        this.help = '';
        this.priv = { priv: U };
        this.solve = async () => { return seal.ext.newCmdExecuteResult(false); };

        SubCmd.map[name] = this;
    }

    static map: { [key: string]: SubCmd } = {};
    static register() {
        registerCmdPrivilege();
        registerCmdPrompt();
        registerCmdStatus();
        registerCmdCtxn();
        registerCmdTimer();
        registerCmdOn();
        registerCmdStandby();
        registerCmdOff();
        registerCmdForget();
        registerCmdRole();
        registerCmdImage();
        registerCmdMemory();
        registerCmdTool();
        registerCmdIgnore();
        registerCmdToken();
        registerCmdShut();

        defaultCmdPriv.ai.args = Object.values(SubCmd.map).reduce((acc, sc) => {
            acc[sc.name] = sc.priv;
            return acc;
        }, {});
    }
}

export function registerCmd() {
    SubCmd.register();

    const cmd = seal.ext.newCmdItemInfo();
    cmd.name = 'ai';
    cmd.help = `帮助:\n${Object.values(SubCmd.map).map((sc) => `【.ai ${sc.name}】${sc.desc}`).join('\n')}`;
    cmd.allowDelegate = true;
    cmd.solve = (ctx, msg, cmdArgs) => {
        try {
            const ret = seal.ext.newCmdExecuteResult(true);

            const subCmd = aliasToCmd(cmdArgs.getArgN(1));
            if (SubCmd.map.hasOwnProperty(aliasToCmd(subCmd))) {
                const uid = ctx.player.userId;
                const gid = ctx.group.groupId;
                const epId = ctx.endPoint.userId;
                const sid = ctx.isPrivate ? uid : gid;

                let page = 1;
                const kwargPage = cmdArgs.kwargs.find((kwarg) => kwarg.name === 'page' || kwarg.name === 'p');
                if (kwargPage && kwargPage.valueExists) {
                    page = parseInt(kwargPage.value);
                    if (isNaN(page)) {
                        seal.replyToSender(ctx, msg, '页码必须为数字');
                        return ret;
                    }
                    if (page < 1) {
                        seal.replyToSender(ctx, msg, '页码必须大于等于1');
                        return ret;
                    }
                }

                const ai = AIManager.getAI(sid);
                const { success, exist } = PrivilegeManager.checkPriv(ctx, cmdArgs, ai);
                if (!success) {
                    seal.replyToSender(ctx, msg, exist ? '权限不足' : '命令不存在');
                    return ret;
                }

                return SubCmd.map[subCmd].solve({ ctx, msg, cmdArgs, epId, uid, gid, sid, ai, page, ret });
            } else {
                ret.showHelp = true;
                return ret;
            }
        } catch (e) {
            logger.error(`指令.ai执行失败:${e.message}`);
            seal.replyToSender(ctx, msg, `指令.ai执行失败:${e.message}`);
            return seal.ext.newCmdExecuteResult(true);
        }
    }

    ConfigManager.ext.cmdMap['AI'] = cmd;
    ConfigManager.ext.cmdMap['ai'] = cmd;
}