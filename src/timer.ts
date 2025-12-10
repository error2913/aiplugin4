import { ConfigManager } from "./config/configManager";
import { getSessionCtxAndMsg } from "./utils/utils_seal";
import { AI, AIManager } from "./AI/AI";
import { logger } from "./logger";
import { fmtDate } from "./utils/utils_string";
import { revive } from "./utils/utils";

export class TimerInfo {
    static validKeys: (keyof TimerInfo)[] = ['sid', 'isPrivate', 'epId', 'set', 'target', 'interval', 'count', 'type', 'content'];
    sid: string;
    isPrivate: boolean;
    epId: string;
    set: number; // 定时器设置时间，单位秒
    target: number; // 定时器具体触发时间，单位秒
    interval: number; // 定时器触发间隔，单位秒
    count: number; // 定时器触发次数，若为-1则无限循环，若为0则不触发，若为其他正整数则触发该次数后停止
    type: 'target' | 'interval' | 'activeTime'; // 定时器类型，目标时间定时器、间隔定时器、活动时间定时器
    content: string;

    constructor() {
        this.sid = '';
        this.isPrivate = false;
        this.epId = '';
        this.set = 0;
        this.target = 0;
        this.interval = 0;
        this.count = 1;
        this.type = 'target';
        this.content = '';
    }
}

export class TimerManager {
    static timerQueue: TimerInfo[] = [];
    static isTaskRunning = false;
    static intervalId: number | null = null;

    static getTimerQueue() {
        try {
            const data = JSON.parse(ConfigManager.ext.storageGet(`timerQueue`) || '[]')
            if (!Array.isArray(data)) throw new Error('timerQueue不是数组');
            data.forEach((item: any) => {
                if (!item.hasOwnProperty('sessionId')) return;
                if (!item.hasOwnProperty('sessionType')) return;
                this.timerQueue.push(revive(TimerInfo, item));
            });
        } catch (e) {
            logger.error('在获取timerQueue时出错', e);
        }
    }

    static saveTimerQueue() {
        ConfigManager.ext.storageSet(`timerQueue`, JSON.stringify(this.timerQueue));
    }

    static addTargetTimer(ctx: seal.MsgContext, ai: AI, target: number, content: string) {
        const uid = ctx.player.userId;
        const gid = ctx.group.groupId;
        const sessionId = ctx.isPrivate ? uid : gid;
        const timer = new TimerInfo();
        timer.sid = sessionId;
        timer.isPrivate = ctx.isPrivate;
        timer.epId = ctx.endPoint.userId;
        timer.set = Math.floor(Date.now() / 1000);
        timer.target = target;
        timer.content = content;

        this.timerQueue.push(timer);
        this.saveTimerQueue();

        if (!this.intervalId) {
            logger.info('定时器任务启动');
            this.executeTask();
        }

        logger.info(`添加${timer.type}定时器${ai.id}:
触发时间:${fmtDate(target)}
内容:${content}`);
    }

    static addIntervalTimer(ctx: seal.MsgContext, ai: AI, interval: number, count: number, content: string) {
        const uid = ctx.player.userId;
        const gid = ctx.group.groupId;
        const sessionId = ctx.isPrivate ? uid : gid;
        const timer = new TimerInfo();
        timer.sid = sessionId;
        timer.isPrivate = ctx.isPrivate;
        timer.epId = ctx.endPoint.userId;
        timer.set = Math.floor(Date.now() / 1000);
        timer.interval = interval;
        timer.count = count;
        timer.type = 'interval';
        timer.content = content;

        this.timerQueue.push(timer);
        this.saveTimerQueue();

        if (!this.intervalId) {
            logger.info('定时器任务启动');
            this.executeTask();
        }

        logger.info(`添加${timer.type}定时器${ai.id}:
间隔:${interval}秒
次数:${count}次
内容:${content}`);
    }

    static addActiveTimeTimer(ctx: seal.MsgContext, ai: AI, target: number) {
        const uid = ctx.player.userId;
        const gid = ctx.group.groupId;
        const sessionId = ctx.isPrivate ? uid : gid;
        const timer = new TimerInfo();
        timer.sid = sessionId;
        timer.isPrivate = ctx.isPrivate;
        timer.epId = ctx.endPoint.userId;
        timer.set = Math.floor(Date.now() / 1000);
        timer.target = target;
        timer.type = 'activeTime';

        this.timerQueue.push(timer);
        this.saveTimerQueue();

        if (!this.intervalId) {
            logger.info('定时器任务启动');
            this.executeTask();
        }

        logger.info(`添加${timer.type}定时器${ai.id}:
触发时间:${fmtDate(target)}`);
    }

    static removeTimers(sid: string = '', content: string = '', types: ('target' | 'interval' | 'activeTime')[] = [], index_list: number[] = []) {
        if (index_list.length > 0) {
            const timers = this.getTimers(sid, content, types);

            for (const index of index_list) {
                if (index < 1 || index > timers.length) {
                    logger.warning(`序号${index}超出范围`);
                    continue;
                }

                const i = this.timerQueue.indexOf(timers[index - 1]);
                if (i === -1) {
                    logger.warning(`出错了:找不到序号${index}的定时器`);
                    continue;
                }

                this.timerQueue.splice(i, 1);
            }
        } else {
            this.timerQueue = this.timerQueue.filter(timer =>
                !(
                    (!sid || timer.sid === sid) &&
                    (!content || timer.content === content) &&
                    (types.length === 0 || types.includes(timer.type))
                )
            );
        }

        this.saveTimerQueue();
    }

    static getTimers(sid: string = '', content: string = '', types: ('target' | 'interval' | 'activeTime')[] = []): TimerInfo[] {
        return this.timerQueue.filter(timer =>
            (!sid || timer.sid === sid) &&
            (!content || timer.content === content) &&
            (types.length === 0 || types.includes(timer.type))
        );
    }

    static getTimerListText(sid: string, p: number = 1): string {
        const timers = TimerManager.getTimers(sid, '', []);
        if (timers.length === 0) return '';
        if (p > Math.ceil(timers.length / 10)) p = Math.ceil(timers.length / 10);
        return timers.slice((p - 1) * 10, p * 10).map((t, i) => {
            switch (t.type) {
                case 'target': return `${i + 1 + (p - 1) * 10}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
目标时间：${fmtDate(t.target)}
内容：${t.content}`;
                case 'interval': return `${i + 1 + (p - 1) * 10}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
间隔时间：${t.interval}秒
剩余触发次数：${t.count === -1 ? '无限' : t.count - 1}
内容：${t.content}`;
                case 'activeTime': return `${i + 1 + (p - 1) * 10}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
目标时间：${fmtDate(t.target)}`;
            }
        }).join('\n') + `\n当前页码:${p}/${Math.ceil(timers.length / 10)}`;
    }

    static async task() {
        try {
            if (this.isTaskRunning) {
                logger.info('定时器任务正在运行，跳过');
                return;
            }

            this.isTaskRunning = true;

            const timerQueue = [...this.timerQueue];
            this.timerQueue = [];
            let changed = false;
            for (const timer of timerQueue) {
                try {
                    switch (timer.type) {
                        case 'target': {
                            const target = timer.target;
                            if (target > Math.floor(Date.now() / 1000)) {
                                this.timerQueue.push(timer);
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                logger.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                continue;
                            }

                            const { sid, isPrivate, epId, set, content } = timer;
                            const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
                            const ai = AIManager.getAI(sid);

                            const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${fmtDate(set)}
目标时间：${fmtDate(target)}
当前触发时间：${fmtDate(Math.floor(Date.now() / 1000))}
提示内容：${content}`;

                            await ai.context.addSystemUserMessage("定时器触发提示", s, []);
                            await ai.chat(ctx, msg, '定时任务');

                            changed = true;
                            break;
                        }
                        case 'interval': {
                            const target = timer.set + timer.interval;
                            if (target > Math.floor(Date.now() / 1000)) {
                                this.timerQueue.push(timer);
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                logger.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                continue;
                            }

                            const { sid, isPrivate, epId, set, interval, count, content } = timer;
                            const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
                            const ai = AIManager.getAI(sid);

                            if (count === -1 || count > 1) {
                                timer.set = Math.floor(Date.now() / 1000);
                                timer.count = count === -1 ? -1 : count - 1;
                                this.timerQueue.push(timer);
                            } else if (count === 0 || count < -1) {
                                continue;
                            }

                            const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${fmtDate(set)}
间隔时间：${fmtDate(interval)}
剩余触发次数：${count === -1 ? '无限' : count - 1}
当前触发时间：${fmtDate(Math.floor(Date.now() / 1000))}
提示内容：${content}`;

                            await ai.context.addSystemUserMessage("定时器触发提示", s, []);
                            await ai.chat(ctx, msg, '定时任务');

                            changed = true;
                            break;
                        }
                        case 'activeTime': {
                            const target = timer.target;
                            if (target > Math.floor(Date.now() / 1000)) {
                                this.timerQueue.push(timer);
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                logger.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                continue;
                            }

                            const { sid, isPrivate, epId, set } = timer;
                            const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
                            const ai = AIManager.getAI(sid);

                            const curSegIndex = ai.curActiveTimeSegIndex;
                            const nextTimePoint = ai.getNextTimePoint(curSegIndex);
                            if (curSegIndex === -1) {
                                logger.error(`${sid} 不在活跃时间内，触发了 activeTime 定时器，真奇怪\ncurSegIndex:${curSegIndex},setTime:${set},nextTimePoint:${fmtDate(nextTimePoint)}`);
                                continue;
                            }
                            if (nextTimePoint !== -1) {
                                this.addActiveTimeTimer(ctx, ai, nextTimePoint);
                            }

                            const messages = ai.context.messages;
                            const lastMsgArray = messages[messages.length - 1].msgArray;
                            const lastTime = lastMsgArray[lastMsgArray.length - 1].time;
                            const lastTimePrompt = `最后一条消息时间：${fmtDate(lastTime)}`;
                            const s = `现在是你的活跃时间：${fmtDate(Math.floor(Date.now() / 1000))}
${lastTimePrompt}
请说点什么`;

                            await ai.context.addSystemUserMessage("活跃时间触发提示", s, []);
                            await ai.chat(ctx, msg, '活跃时间');

                            changed = true;
                            break;
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (e) {
                    logger.error(`${timer.sid} 执行 ${timer.type} 定时器出错，错误信息:${e.message}`);
                }
            }

            if (changed) {
                this.saveTimerQueue();
            }

            this.isTaskRunning = false;
        } catch (e) {
            logger.error(`定时任务处理出错，错误信息:${e.message}`);
        }
    }

    static async executeTask() {
        if (this.timerQueue.length === 0) {
            this.destroy();
            return;
        }

        await this.task();
        this.intervalId = setTimeout(this.executeTask.bind(this), 5000);
    }

    static destroy() {
        if (this.intervalId) {
            clearTimeout(this.intervalId);
            this.intervalId = null;
            logger.info('定时器任务已停止');
        }
    }

    static init() {
        this.getTimerQueue();
        this.executeTask();
    }
}