// 根命令 .ai：子命令注册与分发、会话上下文组装
import { ext } from "../config/config";
import { logger } from "../logger";
import { Session } from "../session/session";
import { getSession } from "../session/session_service";
import { aliasToCmd } from "../utils/utils";

import { CmdPriv, CmdPrivInfo, defaultCmdPriv, PrivilegeManager, U } from "./privilege";
import { registerCmdBlock } from "./sub_cmd/block";
import { registerCmdCtxn } from "./sub_cmd/ctxn";
import { registerCmdForget } from "./sub_cmd/forget";
import { registerCmdIgnore } from "./sub_cmd/ignore";
import { registerCmdImage } from "./sub_cmd/image";
import { registerCmdKB } from "./sub_cmd/kb";
import { registerCmdMemory } from "./sub_cmd/memory";
import { registerCmdModel } from "./sub_cmd/model";
import { registerCmdOff } from "./sub_cmd/off";
import { registerCmdOn } from "./sub_cmd/on";
import { registerCmdPrivilege } from "./sub_cmd/privilege";
import { registerCmdPrompt } from "./sub_cmd/prompt";
import { registerCmdRole } from "./sub_cmd/role";
import { registerCmdShut } from "./sub_cmd/shut";
import { registerCmdStandby } from "./sub_cmd/standby";
import { registerCmdStatus } from "./sub_cmd/status";
import { registerCmdTimer } from "./sub_cmd/timer";
import { registerCmdToken } from "./sub_cmd/token";
import { registerCmdTool } from "./sub_cmd/tool";

export interface SubCmdContext {
    ctx: seal.MsgContext;
    msg: seal.Message;
    cmdArgs: seal.CmdArgs;
    epId: string;
    uid: string;
    gid: string;
    sid: string;
    session: Session;
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
        registerCmdKB();
        registerCmdTool();
        registerCmdIgnore();
        registerCmdToken();
        registerCmdShut();
        registerCmdModel();
        registerCmdBlock();

        defaultCmdPriv.ai.args = Object.values(SubCmd.map).reduce((acc: CmdPriv, sc) => {
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
            if (Object.prototype.hasOwnProperty.call(SubCmd.map, aliasToCmd(subCmd))) {
                const uid = ctx.player!.userId;
                const gid = ctx.group!.groupId;
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

                const session = getSession(sid);
                const { success, exist } = PrivilegeManager.checkPriv(ctx, cmdArgs, session);
                if (!success) {
                    seal.replyToSender(ctx, msg, exist ? '权限不足' : '命令不存在');
                    return ret;
                }

                // 兜住子命令异步异常，避免“无响应”（SealDice 不会消费未捕获的 Promise 拒绝）
                return Promise.resolve(SubCmd.map[subCmd].solve({ ctx, msg, cmdArgs, epId, uid, gid, sid, session, page, ret })).catch((e) => {
                    logger.error(`指令.ai执行失败:${e.message}`);
                    seal.replyToSender(ctx, msg, `指令.ai执行失败:${e.message}`);
                    return ret;
                });
            } else if (subCmd === 'help') {
                // .ai help <一级子指令>：查看对应子命令帮助；不带参数时展示根命令帮助
                const target = aliasToCmd(cmdArgs.getArgN(2));
                if (target) {
                    const targetCmd = SubCmd.map[target];
                    if (targetCmd) {
                        seal.replyToSender(ctx, msg, `【.ai ${targetCmd.name}】${targetCmd.desc}${targetCmd.help ? `\n${targetCmd.help}` : ''}`);
                    } else {
                        seal.replyToSender(ctx, msg, `指令不存在:${target}`);
                    }
                    return ret;
                }
                ret.showHelp = true;
                return ret;
            } else {
                ret.showHelp = true;
                return ret;
            }
        } catch (e) {
            logger.error(`指令.ai执行失败:${e instanceof Error ? e.message : String(e)}`);
            seal.replyToSender(ctx, msg, `指令.ai执行失败:${e instanceof Error ? e.message : String(e)}`);
            return seal.ext.newCmdExecuteResult(true);
        }
    }

    ext.cmdMap['AI'] = cmd;
    ext.cmdMap['ai'] = cmd;
}
