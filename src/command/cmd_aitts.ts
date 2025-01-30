import { ConfigManager } from "../utils/configUtils";
import { Command, CommandManager } from "./commandManager";

const characterMap = {
    "小新": "lucy-voice-laibixiaoxin",
    "猴哥": "lucy-voice-houge",
    "四郎": "lucy-voice-silang",
    "东北老妹儿": "lucy-voice-guangdong-f1",
    "广西大表哥": "lucy-voice-guangxi-m1",
    "妲己": "lucy-voice-daji",
    "霸道总裁": "lucy-voice-lizeyan",
    "酥心御姐": "lucy-voice-suxinjiejie",
    "说书先生": "lucy-voice-m8",
    "憨憨小弟": "lucy-voice-male1",
    "憨厚老哥": "lucy-voice-male3",
    "吕布": "lucy-voice-lvbu",
    "元气少女": "lucy-voice-xueling",
    "文艺少女": "lucy-voice-f37",
    "磁性大叔": "lucy-voice-male2",
    "邻家小妹": "lucy-voice-female1",
    "低沉男声": "lucy-voice-m14",
    "傲娇少女": "lucy-voice-f38",
    "爹系男友": "lucy-voice-m101",
    "暖心姐姐": "lucy-voice-female2",
    "温柔妹妹": "lucy-voice-f36",
    "书香少女": "lucy-voice-f34"
};

export function registerCmdAitts() {
    const cmdAitts = new Command('语音');
    cmdAitts.buildPrompt = () => {
        return '发送语音的命令:<$语音#发送语音的内容>';
    }
    cmdAitts.solve = (ctx, _, __, ___, arg1) => {
        const extHttp = seal.ext.find('HTTP依赖');
        if (!extHttp) {
            console.error(`未找到HTTP依赖`);
            return;
        }

        if (!arg1) {
            console.error(`没有发送语音的内容`);
            return;
        }

        try {
            const { character } = ConfigManager.getTTSConfig();
            const characterId = characterMap[character]; // 获取对应的 character_id
            if (!characterId) {
                console.error(`未找到对应的 character_id: ${character}`);
                return;
            }

            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            globalThis.http.getData(epId, `send_group_ai_record?character=${characterId}&group_id=${group_id}&text=${arg1}`);
        } catch (e) {
            console.error(e);
        }
    }
    CommandManager.registerCommand(cmdAitts);
}
