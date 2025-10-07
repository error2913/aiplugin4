import { ConfigManager } from "./config/config";
import { createCtx, createMsg } from "./utils/utils_seal";
import { AI, AIManager } from "./AI/AI";
import { logger } from "./logger";

export interface TimerInfo {
    id: string,
    messageType: 'private' | 'group',
    uid: string,
    gid: string,
    epId: string,
    timestamp: number, // 定时器触发时间，单位秒
    setTime: string,
    content: string,
    type: 'timer' | 'activeTime'
};

export class TimerManager {
    static timerQueue: TimerInfo[] = [];
    static isTaskRunning = false;
    static intervalId: number | null = null;

    static getTimerQueue() {
        try {
            JSON.parse(ConfigManager.ext.storageGet(`timerQueue`) || '[]')
                .forEach((item: any) => {
                    this.timerQueue.push(item);
                });
        } catch (e) {
            logger.error('在获取timerQueue时出错', e);
        }
    }

    static saveTimerQueue() {
        ConfigManager.ext.storageSet(`timerQueue`, JSON.stringify(this.timerQueue));
    }

    static addTimer(ctx: seal.MsgContext, msg: seal.Message, ai: AI, timestamp: number, content: string, reason: 'timer' | 'activeTime') {
        this.timerQueue.push({
            id: ai.id,
            messageType: msg.messageType,
            uid: ctx.player.userId,
            gid: ctx.group.groupId,
            epId: ctx.endPoint.userId,
            timestamp: timestamp,
            setTime: new Date().toLocaleString(),
            content: content,
            type: reason
        })

        this.saveTimerQueue();

        if (!this.intervalId) {
            logger.info('定时器任务启动');
            this.executeTask();
        }
    }

    static removeTimer(id: string = '', content: string = '', reason: 'timer' | 'activeTime' = 'timer', index_list: number[] = []) {
        if (index_list.length > 0) {
            const timers = TimerManager.timerQueue.filter(t =>
                (id && t.id === id) &&
                (content && t.content === content) &&
                (reason && t.type === reason)
            );

            for (const index of index_list) {
                if (index < 1 || index > timers.length) {
                    logger.warning(`序号${index}超出范围`);
                    continue;
                }

                const i = TimerManager.timerQueue.indexOf(timers[index - 1]);
                if (i === -1) {
                    logger.warning(`出错了:找不到序号${index}的定时器`);
                    continue;
                }

                TimerManager.timerQueue.splice(i, 1);
            }
        } else {
            this.timerQueue = this.timerQueue.filter(timer =>
                (id && timer.id !== id) &&
                (content && timer.content !== content) &&
                (reason && timer.type !== reason)
            );
        }

        this.saveTimerQueue();
    }

    static async task() {
        try {
            if (this.isTaskRunning) {
                logger.info('定时器任务正在运行，跳过');
                return;
            }

            this.isTaskRunning = true;

            const remainingTimers: TimerInfo[] = [];
            let changed = false;
            for (const timer of this.timerQueue) {
                const timestamp = timer.timestamp;
                if (timestamp > Math.floor(Date.now() / 1000)) {
                    remainingTimers.push(timer);
                    continue;
                }

                const { id, messageType, uid, gid, epId, setTime, content, type: reason } = timer;
                const msg = createMsg(messageType, uid, gid);
                const ctx = createCtx(epId, msg);
                const ai = AIManager.getAI(id);

                switch (reason) {
                    case 'timer': {
                        const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${setTime}
当前触发时间：${new Date().toLocaleString()}
提示内容：${content}`;

                        await ai.context.addSystemUserMessage("定时器触发提示", s, []);
                        await ai.chat(ctx, msg, '定时任务');
                        break;
                    }
                    case 'activeTime': {
                        const curSegIndex = ai.getCurSegIndex();
                        const nextTimePoint = ai.getNextTimePoint(curSegIndex);
                        if (nextTimePoint !== -1) {
                            this.addTimer(ctx, msg, ai, nextTimePoint, '', 'activeTime');
                        }

                        if (curSegIndex === -1) {
                            logger.error(`${id} 不在活跃时间内，触发了 activeTime 定时器，真奇怪`);
                            continue;
                        }

                        const s = `现在是你的活跃时间：${new Date().toLocaleString()}，请说点什么`;

                        await ai.context.addSystemUserMessage("活跃时间触发提示", s, []);
                        await ai.chat(ctx, msg, '活跃时间');
                        break;
                    }
                }


                changed = true;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (changed) {
                this.timerQueue = remainingTimers;
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