import { Config } from "./configUtils";

export class Command {
    name: string;
    command: string;
    args: string[];
    prompt: string;
    solve: (ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs, ...extraArgs: string[]) => void;

    constructor(name: string, command: string, ...args: string[]) {
        this.name = name;
        this.command = command;
        this.args = args;
        this.prompt = '';
    }

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

    static registerCommand(cmd: Command) {
        this.cmdMap[cmd.name] = cmd;
    }

    static getCommandsPrompt() {
        return Object.values(this.cmdMap).map(item => item.prompt).join(',');
    }

    static handleCommands(ctx: seal.MsgContext, msg: seal.Message, commands: string[]) {
        if (commands.length !== 0) {
            Config.printLog(`AI命令:`, JSON.stringify(commands));
        }

        if (this.cmdArgs == null) {
            Config.printLog(`暂时无法使用AI命令，请先使用任意指令`);
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

const cmdDraw = new Command('deck', '');
cmdDraw.prompt = '抽取牌堆的命令:<$deck#牌堆的名字$>';
cmdDraw.solve = (ctx, msg, _, name) => {
    const dr = seal.deck.draw(ctx, name, true);
    if (!dr.exists) {
        console.error(`牌堆${name}不存在:${dr.err}`);
    }

    const result = dr.result;
    if (result == null) {
        console.error(`牌堆${name}结果为空:${dr.err}`);
    }

    seal.replyToSender(ctx, msg, result);
}
CommandManager.registerCommand(cmdDraw);

const cmdRename = new Command('rename', '');
cmdRename.prompt = '设置群名片的命令:<$rename#要设置的名字$>';
cmdRename.solve = (ctx, msg, _, name) => {
    try {
        seal.setPlayerGroupCard(ctx, name);
        seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${name}>`);
    } catch (e) {
        console.error(e);
    }
}
CommandManager.registerCommand(cmdRename);

const cmdModuRoll = new Command('随机模组', 'modu', 'roll');
cmdModuRoll.prompt = '随机模组的命令:<$随机模组$>';
cmdModuRoll.solve = (ctx, msg, cmdArgs) => {
    cmdModuRoll.handleCmdArgs(cmdArgs);
    const ext = seal.ext.find('story');
    ext.cmdMap['modu'].solve(ctx, msg, cmdArgs);
}
CommandManager.registerCommand(cmdModuRoll);

const cmdModuSearch = new Command('查询模组','modu', 'show');
cmdModuSearch.prompt = '查询模组的命令:<$查询模组#要查询的关键词$>';
cmdModuSearch.solve = (ctx, msg, cmdArgs, name) => {
    cmdModuSearch.handleCmdArgs(cmdArgs, name);
    const ext = seal.ext.find('story');
    ext.cmdMap['modu'].solve(ctx, msg, cmdArgs);
}
CommandManager.registerCommand(cmdModuSearch);

const cmdRa = new Command('检定','ra');
cmdRa.prompt = '进行检定的命令:<$检定#检定目的或技能名$>';
cmdRa.solve = (ctx, msg, cmdArgs, name) => {
    cmdRa.handleCmdArgs(cmdArgs, name);
    const ext = seal.ext.find('coc7');
    ext.cmdMap['ra'].solve(ctx, msg, cmdArgs);
}
CommandManager.registerCommand(cmdRa);

const cmdStShow = new Command('show', 'st', 'show');
cmdStShow.prompt = '展示属性的指令:<$show$>';
cmdStShow.solve = (ctx, msg, cmdArgs) => {
    cmdStShow.handleCmdArgs(cmdArgs);
    const ext = seal.ext.find('coc7');
    ext.cmdMap['st'].solve(ctx, msg, cmdArgs);
}

const cmdJrrp = new Command('今日人品','jrrp');
cmdJrrp.prompt = '查看今日人品的指令:<$今日人品$>';
cmdJrrp.solve = (ctx, msg, cmdArgs) => {
    cmdJrrp.handleCmdArgs(cmdArgs);
    const ext = seal.ext.find('fun');
    ext.cmdMap['jrrp'].solve(ctx, msg, cmdArgs);
}

const cmdFace = new Command('face','');
cmdFace.prompt = '';
cmdFace.solve = (ctx, msg, _, name) => {
    const { localImages } = Config.getLocalImageConfig();
    if (localImages.hasOwnProperty(name)) {
        seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[name]}]`);
    } else {
        console.error(`本地图片${name}不存在`);
    }
}