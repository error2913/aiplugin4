import { AI } from "./AI/AI";
import { logger } from "./logger";
import { ConfigManager } from "./config/config";

export interface CmdPrivInfo {
    cmd: string[];
    priv: [number, number, number], // 0: 会话所需权限, 1: 会话检查通过后用户所需权限, 2: 强行触发指令用户所需权限, 进行检查时若通过0和1则无需检查2
    args?: CmdPrivInfo[]; // 需通过前一级检查才可检查子命令
}

const defaultCmdPriv: CmdPrivInfo[] = [
    {
        cmd: ["ai", "AI"], priv: [0, 0, 0], args: [
            {
                cmd: ["priv"], priv: [0, 100, 100], args: [
                    {
                        cmd: ["s", "session"], priv: [0, 0, 0], args: [
                            { cmd: ["st"], priv: [0, 0, 0] },
                            { cmd: ["ck"], priv: [0, 0, 0] },
                        ]
                    },
                    { cmd: ["st"], priv: [0, 0, 0] },
                    { cmd: ["show"], priv: [0, 0, 0] },
                    { cmd: ["reset"], priv: [0, 0, 0] },
                ]
            },
            { cmd: ["prompt"], priv: [0, 100, 100] },
            { cmd: ["status"], priv: [0, 0, 0] },
            { cmd: ["ctxn"], priv: [0, 0, 0] },
            {
                cmd: ["timer"], priv: [0, 0, 0], args: [
                    { cmd: ["clr"], priv: [0, 40, 40] }
                ]
            },
            { cmd: ["on"], priv: [1, 40, 100] },
            { cmd: ["sb"], priv: [0, 40, 40] },
            { cmd: ["off"], priv: [0, 40, 40] },
            {
                cmd: ["f", "fgt"], priv: [0, 40, 40], args: [
                    { cmd: ["ass", "assistant"], priv: [0, 0, 0] },
                    { cmd: ["user"], priv: [0, 0, 0] }
                ]
            },
            { cmd: ["role"], priv: [1, 40, 40] },
            {
                cmd: ["memo"], priv: [0, 0, 0], args: [
                    { cmd: ["status"], priv: [0, 0, 0] },
                    {
                        cmd: ["p", "private"], priv: [0, 0, 0], args: [
                            {
                                cmd: ["st"], priv: [0, 0, 0], args: [
                                    { cmd: ["clr"], priv: [0, 0, 0] },
                                ]
                            },
                            { cmd: ["del"], priv: [0, 0, 0] },
                            { cmd: ["show"], priv: [0, 0, 0] },
                            { cmd: ["clr"], priv: [0, 0, 0] }
                        ]
                    },
                    {
                        cmd: ["g", "group"], priv: [0, 40, 40], args: [
                            {
                                cmd: ["st"], priv: [0, 0, 0], args: [
                                    { cmd: ["clr"], priv: [0, 0, 0] },
                                ]
                            },
                            { cmd: ["del"], priv: [0, 0, 0] },
                            { cmd: ["show"], priv: [0, 0, 0] },
                            { cmd: ["clr"], priv: [0, 0, 0] }
                        ]
                    },
                    {
                        cmd: ["s", "short"], priv: [1, 40, 100], args: [
                            { cmd: ["show"], priv: [0, 0, 0] },
                            { cmd: ["clr"], priv: [0, 0, 0] },
                            { cmd: ["on"], priv: [0, 0, 0] },
                            { cmd: ["off"], priv: [0, 0, 0] }
                        ]
                    },
                    { cmd: ["sum"], priv: [1, 40, 100] }
                ]
            },
            {
                cmd: ["tool"], priv: [0, 40, 40], args: [
                    { cmd: ["help"], priv: [0, 0, 0] },
                    { cmd: ["on"], priv: [0, 0, 0] },
                    { cmd: ["off"], priv: [0, 0, 0] },
                    {
                        cmd: ["*"], priv: [1, 100, 100], args: [
                            { cmd: ["on"], priv: [0, 0, 0] },
                            { cmd: ["off"], priv: [0, 0, 0] }
                        ]
                    }
                ]
            },
            {
                cmd: ["ign"], priv: [0, 0, 0], args: [
                    { cmd: ["add"], priv: [0, 0, 0] },
                    { cmd: ["rm"], priv: [0, 0, 0] },
                    { cmd: ["list"], priv: [0, 0, 0] }
                ]
            },
            {
                cmd: ["tk"], priv: [1, 40, 100], args: [
                    { cmd: ["lst"], priv: [0, 0, 0] },
                    { cmd: ["sum"], priv: [0, 0, 0] },
                    { cmd: ["all"], priv: [0, 0, 0] },
                    {
                        cmd: ["y"], priv: [0, 0, 0], args: [
                            { cmd: ["chart"], priv: [0, 0, 0] }
                        ]
                    },
                    {
                        cmd: ["m"], priv: [0, 0, 0], args: [
                            { cmd: ["chart"], priv: [0, 0, 0] }
                        ]
                    },
                    { cmd: ["clr"], priv: [0, 0, 0] }
                ]
            },
            { cmd: ["shut"], priv: [0, 0, 0] }
        ]
    },
    {
        cmd: ["img"], priv: [0, 0, 0], args: [
            {
                cmd: ["draw"], priv: [0, 0, 0], args: [
                    { cmd: ["lcl", "local"], priv: [0, 0, 0] },
                    { cmd: ["stl", "stolen"], priv: [0, 0, 0] },
                    { cmd: ["save"], priv: [0, 0, 0] },
                    { cmd: ["all"], priv: [0, 0, 0] }
                ]
            },
            {
                cmd: ["stl", "steal"], priv: [0, 40, 40], args: [
                    { cmd: ["on"], priv: [0, 0, 0] },
                    { cmd: ["off"], priv: [0, 0, 0] }
                ]
            },
            {
                cmd: ["f", "fgt", "forget"], priv: [0, 40, 40], args: [
                    { cmd: ["stl", "stolen"], priv: [0, 0, 0] },
                    { cmd: ["save"], priv: [0, 0, 0] },
                    { cmd: ["all"], priv: [0, 0, 0] }
                ]
            },
            {
                cmd: ["itt"], priv: [1, 100, 100], args: [
                    { cmd: ["ran"], priv: [0, 0, 0] },
                    { cmd: ["*"], priv: [0, 0, 0] }
                ]
            },
            {
                cmd: ["save"], priv: [0, 40, 40], args: [
                    { cmd: ["show"], priv: [0, 0, 0] },
                    { cmd: ["clr"], priv: [0, 0, 0] },
                    { cmd: ["del"], priv: [0, 0, 0] },
                    { cmd: ["*"], priv: [1, 100, 100] }
                ]
            }
        ]
    },
];

export class PrivilegeManager {
    static cmdPriv: CmdPrivInfo[] = defaultCmdPriv;

    static reviveCmdPriv() {
        try {
            const cmdPriv = JSON.parse(ConfigManager.ext.storageGet('cmdPriv') || '[]');
            if (cmdPriv.length > 0) {
                this.cmdPriv = cmdPriv;
                this.updateCmdPriv(this.cmdPriv, defaultCmdPriv);
            }
        } catch (error) {
            logger.error(`从数据库中获取cmdPriv失败:`, error);
        }
    }

    static saveCmdPriv() {
        ConfigManager.ext.storageSet('cmdPriv', JSON.stringify(this.cmdPriv));
    }

    static updateCmdPriv(cp: CmdPrivInfo[], defaultCp: CmdPrivInfo[]) {
        for (const defaultCpi of defaultCp) {
            const cpi = cp.find(cpi => defaultCpi.cmd.some(c => cpi.cmd.includes(c)));
            if (!cpi) {
                cp.push(defaultCpi);
            } else {
                if (defaultCpi.args) {
                    cpi.cmd = defaultCpi.cmd;
                    if (cpi.args) {
                        this.updateCmdPriv(cpi.args, defaultCpi.args);
                    } else {
                        cpi.args = defaultCpi.args;
                    }
                } else if (cpi.args) {
                    delete cpi.args;
                }
            }
        }
        this.saveCmdPriv();
    }

    static resetCmdPriv() {
        this.cmdPriv = defaultCmdPriv;
        this.saveCmdPriv();
    }

    static getCmdPriv(cmdChain: string[], cp: CmdPrivInfo[] = this.cmdPriv): CmdPrivInfo | null {
        if (cmdChain.length === 0) {
            return null;
        }

        const cpi = cp.find(cpi => cpi.cmd.includes(cmdChain[0]));
        if (!cpi) {
            return null;
        }

        if (cpi.args) {
            return this.getCmdPriv(cmdChain.slice(1), cpi.args);
        }

        return cpi;
    }

    static checkPriv(ctx: seal.MsgContext, cmdArgs: seal.CmdArgs, ai: AI): boolean {
        const sessionPriv = ai.setting.priv;
        const userPriv = ctx.privilegeLevel;
        const cmdChain = [cmdArgs.command, ...cmdArgs.args];

        function checkCmdPriv(cp: CmdPrivInfo[], i: number): boolean {
            if (i >= cmdChain.length) {
                return true;
            }

            for (const cpi of cp) {
                if (!cpi.cmd.includes(cmdChain[i]) && !cpi.cmd.includes("*")) {
                    continue;
                }

                if (sessionPriv >= cpi.priv[0] && userPriv >= cpi.priv[1]) {
                    return cpi.args ? checkCmdPriv(cpi.args, i + 1) : true;
                }

                if (userPriv >= cpi.priv[2]) {
                    return cpi.args ? checkCmdPriv(cpi.args, i + 1) : true;
                }

                return false;
            }

            logger.warning(`权限检查失败，命令：${cmdChain.join(' ')}，未在权限列表中找到匹配项`);
            return false;
        }

        return checkCmdPriv(this.cmdPriv, 0);
    }
}