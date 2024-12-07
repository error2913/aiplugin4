import { Config } from "../utils/configUtils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdFace() {
    const cmdFace = new Command('表情');
    cmdFace.buildPrompt = () => {
        const { localImages } = Config.getLocalImageConfig();
        return `发送表情的指令:<$表情#表情名称$>,表情名称有:${Object.keys(localImages).join('，')}。`;
    };
    cmdFace.solve = (ctx, msg, _, arg1) => {
        if (!arg1) {
            console.error(`发送表情需要一个表情名称`);
            return;
        }

        const { localImages } = Config.getLocalImageConfig();
        if (localImages.hasOwnProperty(arg1)) {
            seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[arg1]}]`);
        } else {
            console.error(`本地图片${arg1}不存在`);
        }
    }
    CommandManager.registerCommand(cmdFace);
}
