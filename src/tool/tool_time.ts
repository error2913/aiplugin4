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

export function registerGetTime() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "get_time",
            description: `获取当前时间`,
            parameters: {
                type: "object",
                properties: {
                },
                required: []
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ___, ____) => {
        return new Date().toLocaleString();
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerSetTimer() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'set_timer',
            description: '设置一个定时器，在指定时间后触发',
            parameters: {
                type: 'object',
                properties: {
                    days: {
                        type: 'integer',
                        description: '天数'
                    },
                    hours: {
                        type: 'integer',
                        description: '小时数'
                    },
                    minutes: {
                        type: 'integer',
                        description: '分钟数'
                    },
                    content: {
                        type: 'string',
                        description: '触发时给自己的的提示词'
                    }
                },
                required: ['minutes', 'content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { days = 0, hours = 0, minutes, content } = args;

        const t = parseInt(days) * 24 * 60 + parseInt(hours) * 60 + parseInt(minutes);
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

export function registerShowTimerList() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'show_timer_list',
            description: '查看当前聊天的所有定时器',
            parameters: {
                type: 'object',
                properties: {
                },
                required: []
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ai, ___) => {
        const timers = timerQueue.filter(t => t.id === ai.id);

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        const s = timers.map((t, i) => {
            return `${i + 1}. 触发内容：${t.content}
${t.setTime} => ${new Date(t.timestamp * 1000).toLocaleString()}`;
        }).join('\n');

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerCancelTimer() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'cancel_timer',
            description: '取消当前聊天的指定定时器',
            parameters: {
                type: 'object',
                properties: {
                    index_list: {
                        type: 'array',
                        items: {
                            type: 'integer'
                        },
                        description: '要取消的定时器序号列表，序号从1开始'
                    }
                },
                required: ['index_list']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ai, args) => {
        const { index_list } = args;
        const timers = timerQueue.filter(t => t.id === ai.id);

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        if (index_list.length === 0) {
            return '请输入要取消的定时器序号';
        }

        for (const index of index_list) {
            if (index < 1 || index > timers.length) {
                return `序号${index}超出范围`;
            }

            const i = timerQueue.indexOf(timers[index - 1]);
            if (i === -1) {
                return `出错了:找不到序号${index}的定时器`;
            }

            timerQueue.splice(i, 1);
        }

        ConfigManager.ext.storageSet(`timerQueue`, JSON.stringify(timerQueue));

        return '定时器取消成功';
    }

    ToolManager.toolMap[info.function.name] = tool;
}