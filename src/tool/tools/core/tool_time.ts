// 定时器工具：目标/间隔定时器设置与查看、取消。
//
// 参数与校验和「默认定时器」TOML / 链 timer 门完全一致（共用 utils/timer_spec.validateTimerSpec）：
// prompts（1~10 条，fire 时随机一条）为必填；content 仅保留旧调用兼容（等价 1 条 prompts）。
import { TimerManager } from "../../../timer";
import { fmtDate, fmtDateTz } from "../../../utils/string";
import { summarizeTimerSpec, validateTimerSpec } from "../../../utils/timer_spec";
import Tool from "../../tool";

export function registerTime() {
    const toolSet = new Tool({
        type: 'function',
        function: {
            name: 'set_timer',
            description: 'Set a timer that fires after the specified time. One of the prompts is picked randomly when it fires.',
            parameters: {
                type: 'object',
                properties: {
                    types: {
                        type: 'string',
                        description: 'Timer type: target = fire at a target time, interval = fire every interval; corresponds to the time parameters below',
                        enum: ['target', 'interval'],
                    },
                    years: { type: 'integer', description: 'Years (target: required with months/days)' },
                    months: { type: 'integer', description: 'Months (target: required with years/days)' },
                    days: { type: 'integer', description: 'Days (target: required with years/months)' },
                    hours: { type: 'integer', description: 'Hours' },
                    minutes: { type: 'integer', description: 'Minutes' },
                    count: { type: 'integer', description: 'Number of times to fire; -1 = unlimited' },
                    prompts: {
                        type: 'array',
                        description: 'Wake prompts (1-10); one is picked randomly each time the timer fires',
                        items: { type: 'string' },
                    },
                },
                required: ['types', 'prompts'],
            },
        },
    });
    toolSet.solve = async (ctx, _msg, session, args) => {
        // 兼容旧调用：content（单条）等价 prompts
        const prompts = Array.isArray(args.prompts) && args.prompts.length > 0
            ? args.prompts
            : (typeof args.content === 'string' && args.content.trim() ? [args.content] : []);
        const result = validateTimerSpec({
            types: args.types,
            years: args.years,
            months: args.months,
            days: args.days,
            hours: args.hours,
            minutes: args.minutes,
            count: args.count,
            prompts,
        });
        if (!result.ok || !result.spec) return `设置定时器失败：\n${result.errors.map(item => `- ${item}`).join('\n')}`;
        const spec = result.spec;
        const content = spec.prompts[0];
        if (spec.types === 'target') {
            TimerManager.addTargetTimer(ctx, session, spec.targetAt || 0, content, spec.prompts);
        } else {
            TimerManager.addIntervalTimer(ctx, session, spec.intervalSec || 60, spec.count, content, spec.prompts);
        }
        return `设置定时器成功：${summarizeTimerSpec(spec)}`;
    };

    const toolShow = new Tool({
        type: 'function',
        function: {
            name: 'show_timer_list',
            description: 'View all timers in the current chat',
            parameters: {
                type: 'object',
                properties: {
                },
                required: []
            }
        }
    });
    toolShow.solve = async (_, __, session, ___) => {
        const timers = TimerManager.getManualTimers(session.sessionId);

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        const s = timers.map((t, i) => {
            const owner = t.ruleId ? `规则${t.ruleId}` : '手动';
            const prompt = (t.prompts && t.prompts.length > 0 ? t.prompts[0] : t.content) || '（无）';
            switch (t.type as 'target' | 'interval') {
                case 'target': {
                    return `${i + 1}. [${owner}] 设定时间：${fmtDate(t.set)}
类型:${t.type}
目标时间：${fmtDate(t.target)}
提示：${prompt}`;
                }
                case 'interval': {
                    return `${i + 1}. [${owner}] 设定时间：${fmtDate(t.set)}
类型:${t.type}
间隔时间：${t.interval}秒
剩余触发次数：${t.count === -1 ? '无限' : t.count - 1}
提示：${prompt}`;
                }
            }
        }).join('\n');

        return s;
    }

    const toolCancel = new Tool({
        type: 'function',
        function: {
            name: 'cancel_timer',
            description: 'Cancel the specified timer in the current chat',
            parameters: {
                type: 'object',
                properties: {
                    index_list: {
                        type: 'array',
                        items: {
                            type: 'integer'
                        },
                        description: 'Timer sequence numbers to cancel, starting at 1'
                    }
                },
                required: ['index_list']
            }
        }
    });
    toolCancel.solve = async (_, __, session, args) => {
        const { index_list } = args;
        const timers = TimerManager.getManualTimers(session.sessionId);

        if (timers.length === 0) {
            return '当前对话没有定时器';
        }

        if (index_list.length === 0) {
            return '请输入要取消的定时器序号';
        }

        const removed = TimerManager.removeTimerEntries(timers, index_list);

        return removed > 0 ? `已取消 ${removed} 个定时器` : '没有可取消的定时器（序号超出范围）';
    }

    // 只读：返回当前本地时间（含时区偏移）。历史消息不再携带时间戳，模型需要"现在"时按需调用。
    const toolGetTime = new Tool({
        type: 'function',
        function: {
            name: 'get_time',
            description: 'Get the current local date and time with the timezone offset, e.g. 2026-11-06 21:24:04 +08:00. Call this whenever you need the exact current moment (history no longer carries message timestamps).',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    });
    toolGetTime.solve = async () => fmtDateTz(Math.floor(Date.now() / 1000));
}
