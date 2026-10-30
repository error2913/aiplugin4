// 命令权限系统：命令权限定义、存储与校验
import { PRIVILEGE_LEVEL_MAP } from "../config/static_config";
import { getHost } from "../core/host";
import { logger } from "../logger";
import { Session } from "../session/session";
import { resolveCmdChain } from "../utils/alias";


export interface CmdPrivInfo {
    priv: [number, number, number], // 0: 会话所需权限, 1: 会话检查通过后用户所需权限, 2: 强行触发指令用户所需权限, 进行检查时若通过0和1则无需检查2
    args?: CmdPriv; // 需通过前一级检查才可检查子命令
}

export interface CmdPriv { [key: string]: CmdPrivInfo };

export const U: [number, number, number] = [0, PRIVILEGE_LEVEL_MAP.user, PRIVILEGE_LEVEL_MAP.user]; // user
export const M: [number, number, number] = [0, PRIVILEGE_LEVEL_MAP.master, PRIVILEGE_LEVEL_MAP.master]; // master
export const I: [number, number, number] = [0, PRIVILEGE_LEVEL_MAP.inviter, PRIVILEGE_LEVEL_MAP.inviter]; // inviter
export const S: [number, number, number] = [1, PRIVILEGE_LEVEL_MAP.inviter, PRIVILEGE_LEVEL_MAP.master]; // spesial，会话所需权限为1，是才能被邀请者使用，否则需为骰主

export const defaultCmdPriv: CmdPriv = { ai: { priv: U } };

export class PrivilegeManager {
    static cmdPriv: CmdPriv = defaultCmdPriv;

    static reviveCmdPriv() {
        try {
            const cmdPriv = JSON.parse(getHost().storage.get('cmdPriv') || '{}');
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
        getHost().storage.set('cmdPriv', JSON.stringify(this.cmdPriv));
    }

    static updateCmdPriv(cp: CmdPriv, defaultCp: CmdPriv): CmdPriv {
        const newCp: CmdPriv = {};
        for (const cmd in defaultCp) {
            const defaultCpi = defaultCp[cmd];
            if (!Object.prototype.hasOwnProperty.call(cp, cmd)) {
                newCp[cmd] = defaultCpi;
            } else {
                const cpi = cp[cmd];
                if (Object.prototype.hasOwnProperty.call(defaultCpi, 'args')) {
                    if (Object.prototype.hasOwnProperty.call(cpi, 'args')) {
                        cpi.args = this.updateCmdPriv(cpi.args || {}, defaultCpi.args || {});
                    } else {
                        cpi.args = defaultCpi.args;
                    }
                } else if (Object.prototype.hasOwnProperty.call(cpi, 'args')) {
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
        return this.walkPrivInfo(resolveCmdChain(cmdChain), 0, cp);
    }

    /** 内部递归：整条链已在入口按用途域归一，递归时按索引前进，禁止二次归一（否则 `p` 会串用途） */
    private static walkPrivInfo(chain: string[], index: number, cp: CmdPriv): CmdPrivInfo | null {
        if (index >= chain.length) return null;
        const cmd = chain[index];
        if (!Object.prototype.hasOwnProperty.call(cp, cmd)) return null;
        const cpi = cp[cmd];
        if (cpi.args && index + 1 < chain.length) return this.walkPrivInfo(chain, index + 1, cpi.args);
        return cpi;
    }

    /** 与 getCmdPrivInfo 类似，但支持 * 通配回退；用于查看“实际生效权限”。 */
    static getEffectiveCmdPrivInfo(cmdChain: string[], cp: CmdPriv = this.cmdPriv): { cpi: CmdPrivInfo; viaWildcard: boolean } | null {
        if (cmdChain.length === 0) {
            return null;
        }
        return this.walkEffectivePrivInfo(resolveCmdChain(cmdChain), 0, cp);
    }

    private static walkEffectivePrivInfo(chain: string[], index: number, cp: CmdPriv): { cpi: CmdPrivInfo; viaWildcard: boolean } | null {
        if (index >= chain.length) return null;
        const cmd = chain[index];
        const exact = Object.prototype.hasOwnProperty.call(cp, cmd);
        const wildcard = Object.prototype.hasOwnProperty.call(cp, "*");
        if (!exact && !wildcard) return null;
        const cpi = exact ? cp[cmd] : cp["*"];
        const viaWildcard = !exact && wildcard;
        if (cpi.args && index + 1 < chain.length) {
            const child = this.walkEffectivePrivInfo(chain, index + 1, cpi.args);
            if (child) return child;
        }
        return { cpi, viaWildcard };
    }

    static checkPriv(ctx: seal.MsgContext, cmdArgs: seal.CmdArgs, session: Session): { success: boolean, exist: boolean } {
        const sessionPriv = session.setting.priv;
        const userPriv = ctx.privilegeLevel;
        // 一次归一：命令位/触发模式位/参数动词位各有别名表（`trg p` = prob，`memo p` = private）
        const cmdChain = resolveCmdChain([cmdArgs.command, ...cmdArgs.args]);

        function checkCmdPriv(cp: CmdPriv, i: number): { success: boolean, exist: boolean } {
            if (i >= cmdChain.length) {
                return { success: true, exist: true };
            }

            const cmd = cmdChain[i];
            if (!Object.prototype.hasOwnProperty.call(cp, cmd) && !Object.prototype.hasOwnProperty.call(cp, "*")) {
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