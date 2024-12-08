import { Command, CommandManager } from "./commandManager";

export function registerCmdSt() {
    const cmdStShow = new Command('展示', 'st', 'show');
    cmdStShow.buildPrompt = () => {
        return '展示属性的指令:<$展示>';
    }
    cmdStShow.solve = (ctx, msg, cmdArgs) => {
        cmdStShow.handleCmdArgs(cmdArgs);

        const ext = seal.ext.find('coc7');
        ext.cmdMap['st'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdStShow);
}
