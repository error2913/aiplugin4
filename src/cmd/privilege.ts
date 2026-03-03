import { AI } from "../AI/AI";
import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { aliasToCmd } from "../utils/utils";
import { PRIVILEGELEVELMAP } from "../config/config";


export interface CmdPrivInfo {
    priv: [number, number, number], // 0: 会话所需权限, 1: 会话检查通过后用户所需权限, 2: 强行触发指令用户所需权限, 进行检查时若通过0和1则无需检查2
    args?: CmdPriv; // 需通过前一级检查才可检查子命令
}

export interface CmdPriv { [key: string]: CmdPrivInfo };

export const U: [number, number, number] = [0, PRIVILEGELEVELMAP.user, PRIVILEGELEVELMAP.user]; // user
export const M: [number, number, number] = [0, PRIVILEGELEVELMAP.master, PRIVILEGELEVELMAP.master]; // master
export const I: [number, number, number] = [0, PRIVILEGELEVELMAP.inviter, PRIVILEGELEVELMAP.inviter]; // inviter
export const S: [number, number, number] = [1, PRIVILEGELEVELMAP.inviter, PRIVILEGELEVELMAP.master]; // spesial，会话所需权限为1，是才能被邀请者使用，否则需为骰主

export const defaultCmdPriv: CmdPriv = { ai: { priv: U } };

export class PrivilegeManager {
    static cmdPriv: CmdPriv = defaultCmdPriv;

    static reviveCmdPriv() {
        try {
            const cmdPriv = JSON.parse(ConfigManager.ext.storageGet('cmdPriv') || '{}');
            if (typeof cmdPriv === 'object' && !Array.isArray(cmdPriv)) {
                this.cmdPriv = this.updateCmdPriv(cmdPriv, JSON.parse(JSON.stringify(defaultCmdPriv)));
                this.saveCmdPriv();
            } else {
                this.resetCmdPriv();
            }
        } catch (error) {
            logger.error(`从数据库中获取cmdPriv失败:`, error);
        }
    }

    static saveCmdPriv() {
        ConfigManager.ext.storageSet('cmdPriv', JSON.stringify(this.cmdPriv));
    }

    static updateCmdPriv(cp: CmdPriv, defaultCp: CmdPriv): CmdPriv {
        const newCp: CmdPriv = {};
        for (const cmd in defaultCp) {
            const defaultCpi = defaultCp[cmd];
            if (!cp.hasOwnProperty(cmd)) {
                newCp[cmd] = defaultCpi;
            } else {
                const cpi = cp[cmd];
                if (defaultCpi.hasOwnProperty('args')) {
                    if (cpi.hasOwnProperty('args')) {
                        cpi.args = this.updateCmdPriv(cpi.args, defaultCpi.args);
                    } else {
                        cpi.args = defaultCpi.args;
                    }
                } else if (cpi.hasOwnProperty('args')) {
                    delete cpi.args;
                }
                newCp[cmd] = cpi;
            }
        }
        return newCp;
    }

    static resetCmdPriv() {
        this.cmdPriv = JSON.parse(JSON.stringify(defaultCmdPriv));
        this.saveCmdPriv();
    }

    static getCmdPrivInfo(cmdChain: string[], cp: CmdPriv = this.cmdPriv): CmdPrivInfo | null {
        if (cmdChain.length === 0) {
            return null;
        }

        const cmd = aliasToCmd(cmdChain[0]);
        if (!cp.hasOwnProperty(cmd)) {
            return null;
        }

        const cpi = cp[cmd];
        if (cpi.args && cmdChain.length > 1) {
            return this.getCmdPrivInfo(cmdChain.slice(1), cpi.args);
        }

        return cpi;
    }

    static checkPriv(ctx: seal.MsgContext, cmdArgs: seal.CmdArgs, ai: AI): { success: boolean, exist: boolean } {
        const sessionPriv = ai.setting.priv;
        const userPriv = ctx.privilegeLevel;
        const cmdChain = [cmdArgs.command, ...cmdArgs.args].map(cmd => aliasToCmd(cmd));

        function checkCmdPriv(cp: CmdPriv, i: number): { success: boolean, exist: boolean } {
            if (i >= cmdChain.length) {
                return { success: true, exist: true };
            }

            const cmd = cmdChain[i];
            if (!cp.hasOwnProperty(cmd) && !cp.hasOwnProperty("*")) {
                logger.warning(`权限检查失败，命令：[${cmdChain.join(' ')}]，未在权限列表中找到匹配项`);
                return { success: false, exist: false };
            }

            const cpi = cp[cmd] || cp["*"];

            if (sessionPriv >= cpi.priv[0] && userPriv >= cpi.priv[1]) {
                return cpi.args ? checkCmdPriv(cpi.args, i + 1) : { success: true, exist: true };
            }

            if (userPriv >= cpi.priv[2]) {
                return cpi.args ? checkCmdPriv(cpi.args, i + 1) : { success: true, exist: true };
            }

            return { success: false, exist: true };
        }

        return checkCmdPriv(this.cmdPriv, 0);
    }
}