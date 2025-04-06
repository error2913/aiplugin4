import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerRecord() {
    const { recordPaths } = ConfigManager.tool;
    const records: { [key: string]: string } = recordPaths.reduce((acc: { [key: string]: string }, path: string) => {
        if (path.trim() === '') {
            return acc;
        }
        try {
            const name = path.split('/').pop().split('.')[0];
            if (!name) {
                throw new Error(`本地语音路径格式错误:${path}`);
            }

            acc[name] = path;
        } catch (e) {
            logger.error(e);
        }
        return acc;
    }, {});

    if (Object.keys(records).length === 0) {
        return;
    }

    const info: ToolInfo = {
        type: "function",
        function: {
            name: "record",
            description: `发送语音，语音名称有:${Object.keys(records).join("、")}`,
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
        const { name } = args;

        if (records.hasOwnProperty(name)) {
            seal.replyToSender(ctx, msg, `[语音:${records[name]}]`);
            return '发送成功';
        } else {
            logger.error(`本地语音${name}不存在`);
            return `本地语音${name}不存在`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

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

export function registerTextToSound() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
        const { text } = args;

        try {
            const { character } = ConfigManager.tool;
            
            if (character === '自定义') {
                const aittsExt = seal.ext.find('AITTS');
                if (!aittsExt) {
                    logger.error(`未找到AITTS依赖`);
                    return `未找到AITTS依赖，请提示用户安装AITTS依赖`;
                }
                
                await globalThis.ttsHandler.generateSpeech(text, ctx, msg);
            } else {
                const ext = seal.ext.find('HTTP依赖');
                if (!ext) {
                    logger.error(`未找到HTTP依赖`);
                    return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
                }

                const characterId = characterMap[character];
                const epId = ctx.endPoint.userId;
                const group_id = ctx.group.groupId.replace(/\D+/g, '');
                await globalThis.http.getData(epId, `send_group_ai_record?character=${characterId}&group_id=${group_id}&text=${text}`);
            }

            return `发送语音成功`;
        } catch (e) {
            logger.error(e);
            return `发送语音失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}