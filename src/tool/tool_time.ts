import { TimerManager } from "../timer";
import { fmtTime } from "../utils/utils_string";
import { Tool } from "./tool";

export function registerTime() {
    const toolGet = new Tool({
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
    });
    toolGet.solve = async (_, __, ___, ____) => {
        return fmtTime(Math.floor(Date.now() / 1000));
    }

    const toolSet = new Tool({
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
    });
    toolSet.solve = async (ctx, msg, ai, args) => {
        const { days = 0, hours = 0, minutes, content } = args;

        const t = parseInt(days) * 24 * 60 + parseInt(hours) * 60 + parseInt(minutes);
        if (isNaN(t)) {
            return '时间应为数字';
        }

        TimerManager.addTimer(ctx, msg, ai, Math.floor(Date.now() / 1000) + t * 60, content, 'timer');

        return `设置定时器成功，请等待`;
    }

    const toolShow = new Tool({
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
    });
    toolShow.solve = async (_, __, ai, ___) => {
        const timers = TimerManager.getTimer(ai.id, '', 'timer');

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        const s = timers.map((t, i) => {
            return `${i + 1}. 触发内容：${t.content}
${t.setTime} => ${fmtTime(t.timestamp)}`;
        }).join('\n');

        return s;
    }

    const toolCancel = new Tool({
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
    });
    toolCancel.solve = async (_, __, ai, args) => {
        const { index_list } = args;
        const timers = TimerManager.getTimer(ai.id, '', 'timer');

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        if (index_list.length === 0) {
            return '请输入要取消的定时器序号';
        }

        TimerManager.removeTimer(ai.id, '', 'timer', index_list);

        return '定时器取消成功';
    }
}