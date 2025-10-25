import { AI } from "./AI/AI";
import { logger } from "./logger";
import { ConfigManager } from "./config/config";


export interface CmdPrivInfo {
    priv: [number, number, number], // 0: 会话所需权限, 1: 会话检查通过后用户所需权限, 2: 强行触发指令用户所需权限, 进行检查时若通过0和1则无需检查2
    help: string;
    args?: CmdPriv; // 需通过前一级检查才可检查子命令
}

export interface CmdPriv { [key: string]: CmdPrivInfo };

// 命令别名映射表，别名：原始命令
export const aliasMap = {
    "AI": "ai",
    "priv": "privilege",
    "ses": "session",
    "st": "set",
    "ck": "check",
    "clr": "clear",
    "sb": "standby",
    "fgt": "forget",
    "f": "forget",
    "ass": "assistant",
    "memo": "memory",
    "p": "private",
    "g": "group",
    "del": "delete",
    "ign": "ignore",
    "rm": "remove",
    "lst": "list",
    "tk": "token",
    "y": "year",
    "m": "month",
    "lcl": "local",
    "stl": "steal",
    "ran": "random",
}

const defaultCmdPriv: CmdPriv = {
    ai: {
        priv: [0, 0, 0], help: '',
        args: {
            privilege: {
                priv: [0, 100, 100], help: '',
                args: {
                    session: {
                        priv: [0, 0, 0], help: '',
                        args: {
                            set: { priv: [0, 0, 0], help: '' },
                            check: { priv: [0, 0, 0], help: '' }
                        }
                    },
                    set: { priv: [0, 0, 0], help: '' },
                    show: { priv: [0, 0, 0], help: '' },
                    reset: { priv: [0, 0, 0], help: '' }
                }
            },
            prompt: { priv: [0, 100, 100], help: '' },
            status: { priv: [0, 0, 0], help: '' },
            ctxn: { priv: [0, 0, 0], help: '' },
            timer: {
                priv: [0, 0, 0], help: '',
                args: {
                    clear: { priv: [0, 40, 40], help: '' }
                }
            },
            on: { priv: [1, 40, 100], help: '' },
            standby: { priv: [0, 40, 40], help: '' },
            off: { priv: [0, 40, 40], help: '' },
            forget: {
                priv: [0, 40, 40], help: '',
                args: {
                    assistant: { priv: [0, 0, 0], help: '' },
                    user: { priv: [0, 0, 0], help: '' }
                }
            },
            role: { priv: [1, 40, 40], help: '' },
            memory: {
                priv: [0, 0, 0], help: '',
                args: {
                    status: { priv: [0, 0, 0], help: '' },
                    private: {
                        priv: [0, 0, 0], help: '',
                        args: {
                            set: {
                                priv: [0, 0, 0], help: '',
                                args: {
                                    clear: { priv: [0, 0, 0], help: '' },
                                    "*": { priv: [0, 0, 0], help: '' }
                                }
                            },
                            delete: { priv: [0, 0, 0], help: '' },
                            show: { priv: [0, 0, 0], help: '' },
                            clear: { priv: [0, 0, 0], help: '' }
                        }
                    },
                    group: {
                        priv: [0, 40, 40], help: '',
                        args: {
                            set: {
                                priv: [0, 0, 0], help: '',
                                args: {
                                    clear: { priv: [0, 0, 0], help: '' },
                                    "*": { priv: [0, 0, 0], help: '' }
                                }
                            },
                            delete: { priv: [0, 0, 0], help: '' },
                            show: { priv: [0, 0, 0], help: '' },
                            clear: { priv: [0, 0, 0], help: '' }
                        }
                    },
                    short: {
                        priv: [1, 40, 100], help: '',
                        args: {
                            show: { priv: [0, 0, 0], help: '' },
                            clear: { priv: [0, 0, 0], help: '' },
                            on: { priv: [0, 0, 0], help: '' },
                            off: { priv: [0, 0, 0], help: '' }
                        }
                    },
                    sum: { priv: [0, 0, 0], help: '' }
                }
            },
            tool: {
                priv: [0, 40, 40], help: '',
                args: {
                    help: { priv: [0, 0, 0], help: '' },
                    on: { priv: [0, 0, 0], help: '' },
                    off: { priv: [0, 0, 0], help: '' },
                    "*": { priv: [0, 100, 100], help: '' }
                }
            },
            ignore: {
                priv: [0, 0, 0], help: '',
                args: {
                    add: { priv: [0, 0, 0], help: '' },
                    remove: { priv: [0, 0, 0], help: '' },
                    list: { priv: [0, 0, 0], help: '' }
                }
            },
            token: {
                priv: [1, 40, 100], help: '',
                args: {
                    list: { priv: [0, 0, 0], help: '' },
                    sum: { priv: [0, 0, 0], help: '' },
                    all: { priv: [0, 0, 0], help: '' },
                    year: {
                        priv: [0, 0, 0], help: '',
                        args: {
                            chart: { priv: [0, 0, 0], help: '' }
                        }
                    },
                    month: {
                        priv: [0, 0, 0], help: '',
                        args: {
                            chart: { priv: [0, 0, 0], help: '' }
                        }
                    },
                    clear: { priv: [0, 0, 0], help: '' }
                }
            },
            shut: { priv: [0, 0, 0], help: '' }
        }
    },
    img: {
        priv: [0, 0, 0], help: '',
        args: {
            draw: {
                priv: [0, 0, 0], help: '',
                args: {
                    local: { priv: [0, 0, 0], help: '' },
                    steal: { priv: [0, 0, 0], help: '' },
                    save: { priv: [0, 0, 0], help: '' },
                    all: { priv: [0, 0, 0], help: '' }
                }
            },
            steal: {
                priv: [0, 40, 40], help: '',
                args: {
                    on: { priv: [0, 0, 0], help: '' },
                    off: { priv: [0, 0, 0], help: '' }
                }
            },
            forget: {
                priv: [0, 40, 40], help: '',
                args: {
                    steal: { priv: [0, 0, 0], help: '' },
                    save: { priv: [0, 0, 0], help: '' },
                    all: { priv: [0, 0, 0], help: '' }
                }
            },
            itt: {
                priv: [0, 100, 100], help: '',
                args: {
                    ran: { priv: [0, 0, 0], help: '' },
                    "*": { priv: [0, 0, 0], help: '' }
                }
            },
            save: {
                priv: [0, 40, 40], help: '',
                args: {
                    show: { priv: [0, 0, 0], help: '' },
                    clear: { priv: [0, 0, 0], help: '' },
                    delete: { priv: [0, 0, 0], help: '' },
                    "*": { priv: [0, 100, 100], help: '' }
                }
            }
        }
    }
};

export class PrivilegeManager {
    static cmdPriv: CmdPriv = defaultCmdPriv;

    static reviveCmdPriv() {
        try {
            const cmdPriv = JSON.parse(ConfigManager.ext.storageGet('cmdPriv') || '{}');
            if (cmdPriv.length > 0) {
                this.cmdPriv = this.updateCmdPriv(cmdPriv, defaultCmdPriv);
                this.saveCmdPriv();
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
                if (defaultCpi.args) {
                    if (cpi.args) {
                        cpi.args = this.updateCmdPriv(cpi.args, defaultCpi.args);
                    } else {
                        cpi.args = defaultCpi.args;
                    }
                } else if (cpi.args) {
                    delete cpi.args;
                }
                newCp[cmd] = cpi;
            }
        }
        return newCp;
    }

    static resetCmdPriv() {
        this.cmdPriv = defaultCmdPriv;
        this.saveCmdPriv();
    }

    static getCmdPriv(cmdChain: string[], cp: CmdPriv = this.cmdPriv): CmdPrivInfo | null {
        if (cmdChain.length === 0) {
            return null;
        }

        const cmd = cmdChain[0];
        if (!cp.hasOwnProperty(cmd)) {
            return null;
        }

        const cpi = cp[cmd];
        if (cpi.args && cmdChain.length > 1) {
            return this.getCmdPriv(cmdChain.slice(1), cpi.args);
        }

        return cpi;
    }

    static checkPriv(ctx: seal.MsgContext, cmdArgs: seal.CmdArgs, ai: AI): { success: boolean, help: string } {
        const sessionPriv = ai.setting.priv;
        const userPriv = ctx.privilegeLevel;
        const cmdChain = [cmdArgs.command, ...cmdArgs.args];

        function checkCmdPriv(cp: CmdPriv, help: string, i: number): { success: boolean, help: string } {
            if (i >= cmdChain.length) {
                return { success: true, help: help };
            }

            const cmd = cmdChain[i];
            if (!cp.hasOwnProperty(cmd) && !cp.hasOwnProperty("*")) {
                logger.warning(`权限检查失败，命令：[${cmdChain.join(' ')}]，未在权限列表中找到匹配项`);
                return { success: false, help: help };
            }

            const cpi = cp[cmd] || cp["*"];

            if (sessionPriv >= cpi.priv[0] && userPriv >= cpi.priv[1]) {
                return cpi.args ? checkCmdPriv(cpi.args, cpi.help, i + 1) : { success: true, help: help };
            }

            if (userPriv >= cpi.priv[2]) {
                return cpi.args ? checkCmdPriv(cpi.args, cpi.help, i + 1) : { success: true, help: help };
            }

            return { success: false, help: `命令：[${cmdChain.join(' ')}]权限不足` };
        }

        return checkCmdPriv(this.cmdPriv, '', 0);
    }
}