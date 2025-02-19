import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

export const timerQueue: {
    id: string,
    messageType: 'private' | 'group',
    uid: string,
    gid: string,
    epId: string,
    timestamp: number,
    setTime: string,
    content: string
}[] = [];

export function registerSetTimer() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'set_timer',
            description: '设置一个定时器，在指定时间后触发',
            parameters: {
                type: 'object',
                properties: {
                    time: {
                        type: 'integer',
                        description: '时间，单位为分钟'
                    },
                    content: {
                        type: 'string',
                        description: '触发时给自己的的提示词'
                    }
                },
                required: ['time', 'content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { time, content } = args;

        const t = parseInt(time);
        if (isNaN(t)) {
            return '时间应为数字';
        }

        timerQueue.push({
            id: ai.id,
            messageType: msg.messageType,
            uid: ctx.player.userId,
            gid: ctx.group.groupId,
            epId: ctx.endPoint.userId,
            timestamp: Math.floor(Date.now() / 1000) + t * 60,
            setTime: new Date().toLocaleString(),
            content: content
        })

        ConfigManager.ext.storageSet(`timerQueue`, JSON.stringify(timerQueue));

        return `设置定时器成功，请等待`;
    }

    ToolManager.toolMap[info.function.name] = tool;
}