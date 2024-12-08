import { Command, CommandManager } from "./commandManager";

export function registerCmdRename() {
    const cmdRename = new Command('改名');
    cmdRename.buildPrompt = () => {
        return '设置群名片的命令:<$改名#要设置的名字>';
    }
    cmdRename.solve = (ctx, msg, _, arg1) => {
        if (!arg1) {
            console.error(`改名需要一个名字`);
            return;
        }

        try {
            seal.setPlayerGroupCard(ctx, arg1);
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${arg1}>`);
        } catch (e) {
            console.error(e);
        }
    }
    CommandManager.registerCommand(cmdRename);
}