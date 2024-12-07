import { Command, CommandManager } from "./commandManager";

export function registerCmdJrrp() {
    const cmdJrrp = new Command('今日人品', 'jrrp');
    cmdJrrp.buildPrompt = () => {
        return '查看今日人品的指令:<$今日人品$>';
    }
    cmdJrrp.solve = (ctx, msg, cmdArgs) => {
        cmdJrrp.handleCmdArgs(cmdArgs);

        const ext = seal.ext.find('fun');
        ext.cmdMap['jrrp'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdJrrp);
}
