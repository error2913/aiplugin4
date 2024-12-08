import { ConfigManager } from "../utils/configUtils";
import { registerCmdDraw } from "./cmd_draw";
import { registerCmdFace } from "./cmd_face";
import { registerCmdJrrp } from "./cmd_jrrp";
import { registerCmdModu } from "./cmd_modu";
import { registerCmdRa } from "./cmd_ra";
import { registerCmdRename } from "./cmd_rename";
import { registerCmdSt } from "./cmd_st";

export class Command {
    name: string;
    command: string;
    args: string[];

    /**
     * 指令的提示信息
     */
    buildPrompt: () => string;

    /**
     * 处理命令的函数
     * @param ctx 
     * @param msg 
     * @param cmdArgs 
     * @param extraArgs 额外参数，即在命令中使用#分割的部分
     */
    solve: (ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs, ...extraArgs: string[]) => void;

    /**
     * @param name 命令的名字，<$这一部分#参数1#参数2>
     * @param command 指令，如 .st show 的st，没有可以不写
     * @param args 指令的参数
     */
    constructor(name: string, command: string = '', ...args: string[]) {
        this.name = name;
        this.command = command;
        this.args = args;
        this.buildPrompt = () => '';
        this.solve = (_, __, ___) => { };
    }

    /**
     * 利用预存的指令信息和额外输入的参数构建一个cmdArgs
     * @param cmdArgs
     * @param extraArgs
     */
    handleCmdArgs(cmdArgs: seal.CmdArgs, ...extraArgs: string[]) {
        cmdArgs.command = this.command;
        cmdArgs.args = this.args.concat(extraArgs);
        cmdArgs.kwargs = [];
        cmdArgs.at = [];
        cmdArgs.rawArgs = cmdArgs.args.join(' ');
        cmdArgs.amIBeMentioned = false;
        cmdArgs.amIBeMentionedFirst = false;
        cmdArgs.cleanArgs = cmdArgs.args.join(' ');
    }
}

export class CommandManager {
    static cmdArgs: seal.CmdArgs = null;
    static cmdMap: { [key: string]: Command } = {};

    static init() {
        registerCmdDraw();
        registerCmdFace();
        registerCmdJrrp();
        registerCmdModu();
        registerCmdRa();
        registerCmdRename();
        registerCmdSt();
    }

    static registerCommand(cmd: Command) {
        this.cmdMap[cmd.name] = cmd;
    }

    static getCommandNames(): string[] {
        return Object.keys(this.cmdMap);
    }

    static getCommandsPrompts(cmdAllow: string[]): string[] {
        return Object.values(this.cmdMap)
            .map(item => {
                if (cmdAllow.includes(item.name)) {
                    return item.buildPrompt();
                } else {
                    return null;
                }
            })
            .filter(item => item !== null);
    }

    static handleCommands(ctx: seal.MsgContext, msg: seal.Message, commands: string[]) {
        if (commands.length !== 0) {
            ConfigManager.printLog(`AI命令:`, JSON.stringify(commands));
        }

        if (this.cmdArgs == null) {
            ConfigManager.printLog(`暂时无法使用AI命令，请先使用任意指令`);
            return;
        }

        if (commands.length > 10) {
            console.error(`AI命令数量过多，请限制在10个以内`);
            return;
        }

        const cmds = commands.map(item => item.split('#'));

        for (let i = 0; i < cmds.length; i++) {
            const cmd = cmds[i][0];
            const args = cmds[i].slice(1);
            if (this.cmdMap.hasOwnProperty(cmd)) {
                this.cmdMap[cmd].solve(ctx, msg, this.cmdArgs, ...args);
            } else {
                console.error(`AI命令${cmd}不存在`);
            }
        }
    }
}











