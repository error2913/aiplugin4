import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

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

export function registerTTS() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'tts',
            description: '发送AI声聊合成语音',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: '要合成的文本'
                    }
                },
                required: ['text']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { text } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        try {
            const { character } = ConfigManager.tool;
            const characterId = characterMap[character];

            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            globalThis.http.getData(epId, `send_group_ai_record?character=${characterId}&group_id=${group_id}&text=${text}`);
            return `发送语音成功`;
        } catch (e) {
            console.error(e);
            return `发送语音失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}