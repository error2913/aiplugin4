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

export interface SegmentTimerInfo {
    id: string,
    messageType: 'private' | 'group',
    uid: string,
    gid: string,
    epId: string,
    timestamp: number,
    setTime: string,
    lastTriggeredSegment: number
};

export class TimerManager {
    static timerQueue: TimerInfo[] = [];
    static segmentTimerQueue: SegmentTimerInfo[] = [];
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

    static getSegmentTimerQueue() {
        try {
            JSON.parse(ConfigManager.ext.storageGet(`segmentTimerQueue`) || '[]')
                .forEach((item: any) => {
                    this.segmentTimerQueue.push(item);
                });
        } catch (e) {
            logger.error('在获取segmentTimerQueue时出错', e);
        }
    }

    static saveSegmentTimerQueue() {
        ConfigManager.ext.storageSet(`segmentTimerQueue`, JSON.stringify(this.segmentTimerQueue));
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

    static addSegmentTimer(ctx: seal.MsgContext, msg: seal.Message, ai: AI) {
        const existingIndex = this.segmentTimerQueue.findIndex(timer => timer.id === ai.id);
        
        const timerInfo = {
            id: ai.id,
            messageType: msg.messageType,
            uid: ctx.player.userId,
            gid: ctx.group.groupId,
            epId: ctx.endPoint.userId,
            timestamp: Math.floor(Date.now() / 1000),
            setTime: new Date().toLocaleString(),
            lastTriggeredSegment: -1
        };
    
        if (existingIndex >= 0) {
            timerInfo.lastTriggeredSegment = this.segmentTimerQueue[existingIndex].lastTriggeredSegment;
            this.segmentTimerQueue[existingIndex] = timerInfo;
        } else {
            this.segmentTimerQueue.push(timerInfo);
        }
    
        this.saveSegmentTimerQueue();
    
        if (!this.intervalId) {
            logger.info('时间段检查任务启动');
            this.executeTask();
        }
    }

    static removeSegmentTimer(aiId: string) {
        const index = this.segmentTimerQueue.findIndex(timer => timer.id === aiId);
        if (index >= 0) {
            this.segmentTimerQueue.splice(index, 1);
            this.saveSegmentTimerQueue();
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

                const { id, messageType, uid, gid, epId, setTime, content } = timer;
                const msg = createMsg(messageType, uid, gid);
                const ctx = createCtx(epId, msg);
                const ai = AIManager.getAI(id);

                const s = `你设置的定时器触发了，请按照以下内容发送回复：
定时器设定时间：${setTime}
当前触发时间：${new Date().toLocaleString()}
提示内容：${content}`;

                await ai.context.addSystemUserMessage("定时器触发提示", s, []);
                
                if (!ai.isInActiveTimeRange()) {
                    await ai.context.addSystemUserMessage("睡眠中", "当前是你的睡眠时间，但定时任务触发了", []);
                }
                
                await ai.chat(ctx, msg, '定时任务');
                changed = true;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (changed) {
                this.timerQueue = remainingTimers;
                this.saveTimerQueue();
            }

            await this.checkSegmentTimers();

            this.isTaskRunning = false;
        } catch (e) {
            logger.error(`定时任务处理出错，错误信息:${e.message}`);
        }
    }

    static async checkSegmentTimers() {
        const remainingTimers: SegmentTimerInfo[] = [];
        let changed = false;
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const currentTimeMinutes = currentHour * 60 + currentMinute;
    
        for (const timer of this.segmentTimerQueue) {
            const ai = AIManager.getAI(timer.id);
            if (!ai) {
                changed = true;
                continue;
            }
    
            if (!ai.privilege.standby || !ai.privilege.activeTimeRange) {
                changed = true;
                continue;
            }
    
            if (!ai.isInActiveTimeRange()) {
                remainingTimers.push(timer);
                continue;
            }
    
            const timePoints = ai.getActiveTimeSegments();
            
            let currentSegmentIndex = -1;
            for (let i = 0; i < timePoints.length; i++) {
                if (currentTimeMinutes >= timePoints[i]) {
                    currentSegmentIndex = i;
                } else {
                    break;
                }
            }
    
            if (currentSegmentIndex === -1) {
                remainingTimers.push(timer);
                continue;
            }
    
            const segmentTime = timePoints[currentSegmentIndex];
            const timeDiff = Math.abs(currentTimeMinutes - segmentTime);
            
            if (timeDiff <= 1) {
                if (timer.lastTriggeredSegment === currentSegmentIndex) {
                    remainingTimers.push(timer);
                    continue;
                }
    
                const hasRecentMessage = ai.hasMessageInCurrentSegment(currentSegmentIndex, timePoints);
                
                if (hasRecentMessage) {
                    timer.lastTriggeredSegment = currentSegmentIndex;
                    changed = true;
                    remainingTimers.push(timer);
                    continue;
                }

                const { messageType, uid, gid, epId } = timer;
                const msg = createMsg(messageType, uid, gid);
                const ctx = createCtx(epId, msg);
                
                const s = `当前时间：${now.toLocaleString()}为你的活跃时间段`;
                await ai.context.addSystemUserMessage("活跃时间段触发提示", s, []);
                await ai.chat(ctx, msg, '活跃时间段触发');
                
                timer.lastTriggeredSegment = currentSegmentIndex;
                changed = true;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
    
            remainingTimers.push(timer);
        }
    
        if (changed) {
            this.segmentTimerQueue = remainingTimers;
            this.saveSegmentTimerQueue();
        }
    }

    static async executeTask() {
        if (this.timerQueue.length === 0 && this.segmentTimerQueue.length === 0) {
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
        this.getSegmentTimerQueue();
    }
}