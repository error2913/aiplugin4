import { ConfigManager } from "../utils/configUtils";
import { Command, CommandManager } from "./commandManager";

export function registerCmdFace() {
    const cmdFace = new Command('表情');
    cmdFace.buildPrompt = () => {
        const { localImages } = ConfigManager.getLocalImageConfig();
        const imagesNames = Object.keys(localImages);
        if (imagesNames.length == 0) {
            return '暂无本地表情';
        }

        return `发送表情的指令:<$表情#表情名称>,表情名称有:${imagesNames.join('、')}。`;
    };
    cmdFace.solve = (ctx, msg, _, __, arg1) => {
        if (!arg1) {
            console.error(`发送表情需要一个表情名称`);
            return;
        }

        const { localImages } = ConfigManager.getLocalImageConfig();
        if (localImages.hasOwnProperty(arg1)) {
            seal.replyToSender(ctx, msg, `[CQ:image,file=${localImages[arg1]}]`);
        } else {
            console.error(`本地图片${arg1}不存在`);
        }
    }
    CommandManager.registerCommand(cmdFace);
}
