import { ConfigManager } from "../utils/configUtils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdDraw() {
    const cmdDraw = new Command('抽取');
    cmdDraw.buildPrompt = () => {
        const { decks } = ConfigManager.getDeckConfig();
        return `抽取牌堆的命令:<$抽取#牌堆的名字>,牌堆的名字有:${decks.join('、')}。`
    }
    cmdDraw.solve = (ctx, msg, _, __, arg1) => {
        if (!arg1) {
            console.error(`抽取牌堆需要一个牌堆的名字`);
            return;
        }

        const dr = seal.deck.draw(ctx, arg1, true);
        if (!dr.exists) {
            console.error(`牌堆${arg1}不存在:${dr.err}`);
        }

        const result = dr.result;
        if (result == null) {
            console.error(`牌堆${arg1}结果为空:${dr.err}`);
        }

        seal.replyToSender(ctx, msg, result);
    }
    CommandManager.registerCommand(cmdDraw);
}
