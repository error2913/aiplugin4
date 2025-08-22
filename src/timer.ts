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
    timestamp: number,
    setTime: string,
    content: string
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

    static addTimer(ctx: seal.MsgContext, msg: seal.Message, ai: AI, t: number, content: string) {
        this.timerQueue.push({
            id: ai.id,
            messageType: msg.messageType,
            uid: ctx.player.userId,
            gid: ctx.group.groupId,
            epId: ctx.endPoint.userId,
            timestamp: Math.floor(Date.now() / 1000) + t * 60,
            setTime: new Date().toLocaleString(),
            content: content
        })

        this.saveTimerQueue();

        if (!this.intervalId) {
            logger.info('定时器任务启动');
            this.executeTask();
        }
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

                const setTime = timer.setTime;
                const content = timer.content;
                const id = timer.id;
                const messageType = timer.messageType;
                const uid = timer.uid;
                const gid = timer.gid;
                const epId = timer.epId;
                const msg = createMsg(messageType, uid, gid);
                const ctx = createCtx(epId, msg);
                const ai = AIManager.getAI(id);

                const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${setTime}
当前触发时间：${new Date().toLocaleString()}
提示内容：${content}`;

                await ai.context.addSystemUserMessage("定时器触发提示", s, []);
                await ai.chat(ctx, msg, '定时任务');

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