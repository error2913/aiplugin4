import { Command, CommandManager } from "./commandManager";

export function registerCmdRa() {
    const cmdRa = new Command('检定', 'ra');
    cmdRa.buildPrompt = () => {
        return '进行检定的命令:<$检定#检定目的或技能名$>';
    }
    cmdRa.solve = (ctx, msg, cmdArgs, arg1) => {
        if (!arg1) {
            console.error(`检定需要一个检定目的或技能名`);
            return;
        }

        cmdRa.handleCmdArgs(cmdArgs, arg1);

        const ext = seal.ext.find('coc7');
        ext.cmdMap['ra'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdRa);
}
