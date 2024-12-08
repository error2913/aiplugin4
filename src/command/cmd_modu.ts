import { Command, CommandManager } from "./commandManager";

export function registerCmdModu() {
    const cmdModu = new Command('模组', 'modu');
    cmdModu.buildPrompt = () => {
        return `随机模组的命令:<$模组#随机>,
查询模组的命令:<$模组#查询#要查询的关键词>`;
    }
    cmdModu.solve = (ctx, msg, cmdArgs, arg1, arg2) => {
        if (!arg1) {
            console.error(`随机模组需要一个指令`);
            return;
        }

        switch (arg1) {
            case '随机': {
                arg1 = 'roll';
                cmdModu.handleCmdArgs(cmdArgs, arg1);
                break;
            }
            case '查询': {
                if (!arg2) {
                    console.error(`查询模组需要一个关键词`);
                    return;
                }
                arg1 = 'search';
                cmdModu.handleCmdArgs(cmdArgs, arg1, arg2);
                break;
            }
            default: {
                console.error(`未知的模组指令:${arg1}`);
                return;
            }
        }

        const ext = seal.ext.find('story');
        ext.cmdMap['modu'].solve(ctx, msg, cmdArgs);
    }
    CommandManager.registerCommand(cmdModu);
}
