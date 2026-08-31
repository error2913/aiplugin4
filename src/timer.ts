// 定时器模块：目标/间隔/活跃时间段/WAIT轮末 四类定时任务的调度与持久化
import { ext } from "./config/config";
import { JudgeManager } from "./judge/judge_manager";
import { logger } from "./logger";
import { Session } from "./session/session";
import { getSession } from "./session/session_service";
import { getSessionCtxAndMsg } from "./utils/seal";
import { fmtDate } from "./utils/string";
import { revive, TypeDescriptor } from "./utils/utils";

const log = logger.withTag('timer');

export class TimerInfo {
    static validKeys: (keyof TimerInfo)[] = ['sid', 'isPrivate', 'epId', 'set', 'target', 'interval', 'count', 'type', 'content'];
    static validKeysMap: { [key in keyof TimerInfo]?: TypeDescriptor<TimerInfo[key]> } = {
        sid: 'string',
        isPrivate: 'boolean',
        epId: 'string',
        set: 'number',
        target: 'number',
        interval: 'number',
        count: 'number',
        type: 'string',
        content: 'string'
    }
    sid: string;
    isPrivate: boolean;
    epId: string;
    set: number; // 定时器设置时间，单位秒
    target: number; // 定时器具体触发时间，单位秒
    interval: number; // 定时器触发间隔，单位秒
    count: number; // 定时器触发次数，若为-1则无限循环，若为0则不触发，若为其他正整数则触发该次数后停止
    type: 'target' | 'interval' | 'activeTime' | 'judgeWait'; // 定时器类型，目标时间定时器、间隔定时器、活动时间定时器、评分WAIT轮末定时器
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
            const data = JSON.parse(ext.storageGet(`timerQueue`) || '[]')
            if (!Array.isArray(data)) throw new Error('timerQueue不是数组');
            data.forEach((item: any) => {
                // 旧实现的过滤条件用 sessionId/sessionType 字段名，与 TimerInfo 的 sid/isPrivate 不一致，导致重载后队列恒空；改为校验实际存档字段 sid
                if (!Object.prototype.hasOwnProperty.call(item, 'sid')) return;
                this.timerQueue.push(revive(TimerInfo, item));
            });
        } catch (e) {
            log.exception('在获取timerQueue时出错', e);
        }
    }

    static saveTimerQueue() {
        ext.storageSet(`timerQueue`, JSON.stringify(this.timerQueue));
    }

    static addTargetTimer(ctx: seal.MsgContext, session: Session, target: number, content: string) {
        const uid = ctx.player!.userId;
        const sessionId = ctx.isPrivate ? uid : ctx.group!.groupId;
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
            log.info('定时器任务启动');
            this.executeTask();
        }

        log.info(`添加${timer.type}定时器${session.id}:
触发时间:${fmtDate(target)}
内容:${content}`);
    }

    static addIntervalTimer(ctx: seal.MsgContext, session: Session, interval: number, count: number, content: string) {
        const uid = ctx.player!.userId;
        const sessionId = ctx.isPrivate ? uid : ctx.group!.groupId;
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
            log.info('定时器任务启动');
            this.executeTask();
        }

        log.info(`添加${timer.type}定时器${session.id}:
间隔:${interval}秒
次数:${count}次
内容:${content}`);
    }

    static addActiveTimeTimer(ctx: seal.MsgContext, session: Session, target: number) {
        const uid = ctx.player!.userId;
        const sessionId = ctx.isPrivate ? uid : ctx.group!.groupId;
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
            log.info('定时器任务启动');
            this.executeTask();
        }

        log.info(`添加${timer.type}定时器${session.id}:
触发时间:${fmtDate(target)}`);
    }

    /** 评分 WAIT 轮末兜底定时器：到点后由 task 调 JudgeManager.endWaitRound 把轮内挂起消息重新过 gate（一次性） */
    static addJudgeWaitTimer(ctx: seal.MsgContext, session: Session, target: number) {
        const uid = ctx.player!.userId;
        const sessionId = ctx.isPrivate ? uid : ctx.group!.groupId;
        const timer = new TimerInfo();
        timer.sid = sessionId;
        timer.isPrivate = ctx.isPrivate;
        timer.epId = ctx.endPoint.userId;
        timer.set = Math.floor(Date.now() / 1000);
        timer.target = target;
        timer.type = 'judgeWait';

        this.timerQueue.push(timer);
        this.saveTimerQueue();

        if (!this.intervalId) {
            log.info('定时器任务启动');
            this.executeTask();
        }

        log.info(`添加${timer.type}定时器${session.id}:
触发时间:${fmtDate(target)}`);
    }

    static removeTimers(sid: string = '', content: string = '', types: ('target' | 'interval' | 'activeTime' | 'judgeWait')[] = [], index_list: number[] = []) {
        if (index_list.length > 0) {
            const timers = this.getTimers(sid, content, types);

            for (const index of index_list) {
                if (index < 1 || index > timers.length) {
                    log.warning(`序号${index}超出范围`);
                    continue;
                }

                const i = this.timerQueue.indexOf(timers[index - 1]);
                if (i === -1) {
                    log.warning(`出错了:找不到序号${index}的定时器`);
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

    static getTimers(sid: string = '', content: string = '', types: ('target' | 'interval' | 'activeTime' | 'judgeWait')[] = []): TimerInfo[] {
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
                case 'judgeWait': return `${i + 1 + (p - 1) * 10}. 定时器设定时间：${fmtDate(t.set)}
类型:${t.type}
WAIT轮末时间：${fmtDate(t.target)}`;
            }
        }).join('\n') + `\n当前页码:${p}/${Math.ceil(timers.length / 10)}`;
    }

    static async task() {
        try {
            if (this.isTaskRunning) {
                log.info('定时器任务正在运行，跳过');
                return;
            }

            this.isTaskRunning = true;

            // 写穿式处理：不再整体清空队列再重建，改为遍历快照，逐条按语义就地变更（保留/移除）并立即落盘，
            // 任何一步完成后存储与内存队列始终一致，进程随时被杀都不会丢已变更的状态
            const snapshot = [...this.timerQueue];
            const removeTimer = (timer: TimerInfo) => {
                const idx = this.timerQueue.indexOf(timer);
                if (idx !== -1) this.timerQueue.splice(idx, 1);
                this.saveTimerQueue();
            };
            for (const timer of snapshot) {
                try {
                    switch (timer.type) {
                        case 'target': {
                            const target = timer.target;
                            if (target > Math.floor(Date.now() / 1000)) {
                                // 未到点：队列本就保留该定时器，无需任何操作
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                log.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                removeTimer(timer);
                                continue;
                            }

                            const { sid, isPrivate, epId, set, content } = timer;
                            const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
                            const session = getSession(sid);

                            const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${fmtDate(set)}
目标时间：${fmtDate(target)}
当前触发时间：${fmtDate(Math.floor(Date.now() / 1000))}
提示内容：${content}`;

                            try {
                                await session.context.addSystemUserMessage(s, "定时器触发提示");
                                await session.chat(ctx, msg, '定时任务');
                                // 一次性定时器执行成功，从队列移除并立即落盘；执行失败保留（下一轮重试）
                                removeTimer(timer);
                            } catch (e) {
                                log.exception(`${timer.sid} 执行 ${timer.type} 定时器出错`, e);
                            }
                            break;
                        }
                        case 'interval': {
                            const target = timer.set + timer.interval;
                            if (target > Math.floor(Date.now() / 1000)) {
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                log.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                removeTimer(timer);
                                continue;
                            }

                            const { sid, isPrivate, epId, set, interval, count, content } = timer;
                            const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
                            const session = getSession(sid);

                            // 无效次数：不触发，直接移除
                            if (count === 0 || count < -1) {
                                removeTimer(timer);
                                break;
                            }
                            // 循环/未到末次：执行前先更新 set/count 并落盘，执行失败也不丢（与原「先重新入队」语义一致）
                            if (count === -1 || count > 1) {
                                timer.set = Math.floor(Date.now() / 1000);
                                timer.count = count === -1 ? -1 : count - 1;
                                this.saveTimerQueue();
                            } else {
                                // count === 1：本次为最后一次，执行前移除并落盘（原清队语义：末次触发后不再入队）
                                removeTimer(timer);
                            }

                            const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${fmtDate(set)}
间隔时间：${fmtDate(interval)}
剩余触发次数：${count === -1 ? '无限' : count - 1}
当前触发时间：${fmtDate(Math.floor(Date.now() / 1000))}
提示内容：${content}`;

                            await session.context.addSystemUserMessage(s, "定时器触发提示");
                            await session.chat(ctx, msg, '定时任务');
                            break;
                        }
                        case 'activeTime': {
                            const target = timer.target;
                            if (target > Math.floor(Date.now() / 1000)) {
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                log.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                removeTimer(timer);
                                continue;
                            }

                            const { sid, isPrivate, epId, set } = timer;
                            const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
                            const session = getSession(sid);

                            const curSegIndex = session.curActiveTimeSegIndex;
                            const nextTimePoint = session.getNextTimePoint(curSegIndex);
                            if (curSegIndex === -1) {
                                log.error(`${sid} 不在活跃时间内，触发了 activeTime 定时器，真奇怪\ncurSegIndex:${curSegIndex},setTime:${set},nextTimePoint:${fmtDate(nextTimePoint)}`);
                                removeTimer(timer);
                                continue;
                            }
                            if (nextTimePoint !== -1) {
                                this.addActiveTimeTimer(ctx, session, nextTimePoint);
                            }
                            // 旧 activeTime 定时器已执行/被新定时器替代，从队列移除并落盘（addActiveTimeTimer 已把新定时器入队并落盘）
                            removeTimer(timer);

                            const messages = session.context.messages;
                            const lastMsg = messages[messages.length - 1] as any;
                            const items = lastMsg?.contentItems || [];
                            const lastTime = items[items.length - 1]?.time || 0;
                            const lastTimePrompt = `最后一条消息时间：${fmtDate(lastTime)}`;
                            const s = `现在是你的活跃时间：${fmtDate(Math.floor(Date.now() / 1000))}
${lastTimePrompt}
请说点什么`;

                            await session.context.addSystemUserMessage(s, "活跃时间触发提示");
                            await session.chat(ctx, msg, '活跃时间');
                            break;
                        }
                        case 'judgeWait': {
                            const target = timer.target;
                            if (target > Math.floor(Date.now() / 1000)) {
                                continue;
                            } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
                                log.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
                                removeTimer(timer);
                                continue;
                            }

                            // WAIT 轮末兜底：轮内若有挂起消息则重新过 gate 评分；一次性定时器，轮未到点（秒级定时目标与毫秒截止的舍入差）时保留
                            const ended = await JudgeManager.endWaitRound(timer.sid);
                            if (!ended) {
                                // 未到点通常意味着 waitUntil 被新一轮 WAIT 延长；若该会话已有更新的 judgeWait 定时器（非当前快照项），
                                // 说明旧定时器已被覆盖（含 task 快照与新建之间的竞态），直接丢弃避免堆积
                                const hasNewer = this.timerQueue.some(t => t !== timer && t.sid === timer.sid && t.type === 'judgeWait');
                                if (hasNewer) {
                                    removeTimer(timer);
                                }
                                continue;
                            }
                            removeTimer(timer);
                            break;
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (e) {
                    log.error(`${timer.sid} 执行 ${timer.type} 定时器出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
                }
            }

            this.isTaskRunning = false;
        } catch (e) {
            log.exception('定时任务处理出错', e);
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
            log.info('定时器任务已停止');
        }
    }

    static init() {
        this.getTimerQueue();
        this.executeTask();
    }
}
