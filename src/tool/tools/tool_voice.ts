import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";
import { netExists, sendGroupAISound } from "../utils/utils_ob11";

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

export function registerRecord() {
    const { recordPathMap } = ConfigManager.tool;

    if (Object.keys(recordPathMap).length !== 0) {
        const toolRecord = new Tool({
            type: "function",
            function: {
                name: "record",
                description: `发送语音，语音名称有:${Object.keys(recordPathMap).join("、")}`,
                parameters: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: "语音名称"
                        }
                    },
                    required: ["name"]
                }
            }
        });
        toolRecord.solve = async (ctx, msg, _, args) => {
            const { name } = args;

            if (recordPathMap.hasOwnProperty(name)) {
                seal.replyToSender(ctx, msg, `[语音:${recordPathMap[name]}]`);
                return { content: '发送成功', images: [] };
            } else {
                logger.error(`本地语音${name}不存在`);
                return { content: `本地语音${name}不存在`, images: [] };
            }
        }
    }

    const toolTTS = new Tool({
        type: 'function',
        function: {
            name: 'text_to_sound',
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
    });
    toolTTS.solve = async (ctx, msg, _, args) => {
        const { text } = args;

        const { character } = ConfigManager.tool;
        if (character === '自定义') {
            const aittsExt = seal.ext.find('AITTS');
            if (!aittsExt) {
                logger.error(`未找到AITTS依赖`);
                return { content: `未找到AITTS依赖，请提示用户安装AITTS依赖`, images: [] };
            }
            try {
                await globalThis.ttsHandler.generateSpeech(text, ctx, msg);
            } catch (e) {
                logger.error(e);
                return { content: `发送语音失败`, images: [] };
            }

            return { content: `发送语音成功`, images: [] };
        }

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        const characterId = characterMap[character];
        await sendGroupAISound(epId, characterId, gid.replace(/^.+:/, ''), text);

        return { content: `发送语音成功`, images: [] };
    }
}