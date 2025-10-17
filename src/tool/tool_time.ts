import { TimerManager } from "../timer";
import { fmtDate } from "../utils/utils_string";
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
        return fmtDate(Math.floor(Date.now() / 1000));
    }

    const toolSet = new Tool({
        type: 'function',
        function: {
            name: 'set_timer',
            description: '设置一个定时器，在指定时间后触发',
            parameters: {
                type: 'object',
                properties: {
                    types: {
                        type: 'string',
                        description: '定时器类型，target为目标时间，interval为间隔时间，对应下面的时间参数',
                        enum: ['target', 'interval']
                    },
                    years: {
                        type: 'integer',
                        description: '年数'
                    },
                    months: {
                        type: 'integer',
                        description: '月数'
                    },
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
                    count: {
                        type: 'integer',
                        description: '触发次数，-1为无限次'
                    },
                    content: {
                        type: 'string',
                        description: '触发时给自己的的提示词'
                    }
                },
                required: ['types', 'minutes', 'content']
            }
        }
    });
    toolSet.solve = async (ctx, msg, ai, args) => {
        const { types, years = 0, months = 0, days = 0, hours = 0, minutes, count = 1, content } = args;

        const y = parseInt(years);
        const m = parseInt(months);
        const d = parseInt(days);
        const h = parseInt(hours);
        const min = parseInt(minutes);
        const c = parseInt(count);
        if (isNaN(y)) return '年数应为数字';
        if (isNaN(m)) return '月数应为数字';
        if (isNaN(d)) return '天数应为数字';
        if (isNaN(h)) return '小时数应为数字';
        if (isNaN(min)) return '分钟数应为数字';
        if (isNaN(c)) return '触发次数应为数字';

        switch (types) {
            case 'target': {
                const t = new Date(y, m - 1, d, h, min).getTime();
                const now = Date.now();
                if (isNaN(t)) {
                    return '时间设置错误';
                }
                if (t < now) {
                    return '目标时间不能早于当前时间';
                }
                if (t - now > 365 * 24 * 60 * 60 * 1000) {
                    return '目标时间不能超过1年';
                }
                TimerManager.addTargetTimer(ctx, msg, ai, Math.floor(t / 1000), content);
                break;
            }
            case 'interval': {
                const mins = y * 365 * 24 * 60 + m * 30 * 24 * 60 + d * 24 * 60 + h * 60 + min;
                if (mins <= 0) {
                    return '间隔时间必须大于0';
                }
                if (mins > 365 * 24 * 60) {
                    return '间隔时间不能大于1年';
                }
                if (c < -1 || c === 0) {
                    return '触发次数不能小于-1或等于0';
                }
                if (c === -1 && mins < 12 * 60) {
                    return '无限次触发间隔时间不能小于12小时';
                }
                if (c > 30) {
                    return '触发次数不能大于30次';
                }
                TimerManager.addIntervalTimer(ctx, msg, ai, mins * 60, c, content);
                break;
            } default: {
                return '定时器类型错误';
            }
        }

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
        const timers = TimerManager.getTimers(ai.id, '', ['target', 'interval']);

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        const s = timers.map((t, i) => {
            switch (t.type as 'target' | 'interval') {
                case 'target': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
目标时间：${fmtDate(t.target)}
内容：${t.content}`;
                }
                case 'interval': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
间隔时间：${t.interval}秒
剩余触发次数：${t.count === -1 ? '无限' : t.count - 1}
内容：${t.content}`;
                }
            }
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
        const timers = TimerManager.getTimers(ai.id, '', ['target', 'interval']);

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        if (index_list.length === 0) {
            return '请输入要取消的定时器序号';
        }

        TimerManager.removeTimers(ai.id, '', ['target', 'interval'], index_list);

        return '定时器取消成功';
    }
}