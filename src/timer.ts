// 定时器模块：目标/间隔/活跃时间段/WAIT轮末 四类定时任务的调度与持久化
import { getHost } from "./core/host";
import { finishJudgeWaitRound, setJudgeWaitScheduler } from "./core/ports/judge_wait";
import { getSessionById } from "./core/ports/session_lookup";
import {
    fireTriggerTimer,
    ownsTriggerTimer,
    setTriggerTimerScheduler,
} from "./core/ports/trigger_timer";
import type { RuleTimerSpec, RuleTimerTarget } from "./core/ports/trigger_timer";
import { logger } from "./logger";
import type { Session } from "./session/session";
import { SYSTEM_NAME } from "./utils/protocol";
import { revive, TypeDescriptor } from "./utils/revive";
import { applyLastMessageRef, getSessionCtxAndMsg } from "./utils/seal";
import { fmtDate } from "./utils/string";
import { pickPrompt } from "./utils/timer_spec";


const log = logger.withTag('timer');

export class TimerInfo {
    static validKeys: (keyof TimerInfo)[] = ['sid', 'isPrivate', 'epId', 'set', 'target', 'interval', 'count', 'type', 'content', 'prompts', 'ruleId', 'modeTag'];
    static validKeysMap: { [key in keyof TimerInfo]?: TypeDescriptor<TimerInfo[key]> } = {
        sid: 'string',
        isPrivate: 'boolean',
        epId: 'string',
        set: 'number',
        target: 'number',
        interval: 'number',
        count: 'number',
        type: 'string',
        content: 'string',
        prompts: { objectValue: 'any' },
        ruleId: 'string',
        modeTag: 'string'
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
    /** 多条唤醒提示（1~10，fire 随机一条）；规则/模式定时器写入，旧存档无此字段 */
    prompts?: string[];
    /** 规则/模式标识（普通定时器无此字段；存在时由触发域端口 owns() 接管） */
    ruleId?: string;
    /** 条目归属：隐式模式规则 / 门控链规则 */
    modeTag?: 'mode' | 'rule';

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
            const data = JSON.parse(getHost().storage.get(`timerQueue`) || '[]')
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
        getHost().storage.set(`timerQueue`, JSON.stringify(this.timerQueue));
    }

    static addTargetTimer(ctx: seal.MsgContext, session: Session, target: number, content: string, prompts?: string[]) {
        const uid = ctx.player!.userId;
        const sessionId = ctx.isPrivate ? uid : ctx.group!.groupId;
        const timer = new TimerInfo();
        timer.sid = sessionId;
        timer.isPrivate = ctx.isPrivate;
        timer.epId = ctx.endPoint.userId;
        timer.set = Math.floor(Date.now() / 1000);
        timer.target = target;
        timer.content = content;
        if (prompts && prompts.length > 0) timer.prompts = [...prompts];

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

    static addIntervalTimer(ctx: seal.MsgContext, session: Session, interval: number, count: number, content: string, prompts?: string[]) {
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
        if (prompts && prompts.length > 0) timer.prompts = [...prompts];

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

    /**
     * 注册规则/模式定时器（由触发域经 L0 端口调用）：
     * - 生命周期由触发域 handler.fire 负责（触发后 removeRuleTimers / 递减 count 再 add）；
     * - task() 遇到 ruleId 条目只做分派（owns/fire），不再按旧 target/interval 语义消费。
     */
    static addRuleTimer(target: RuleTimerTarget, spec: RuleTimerSpec) {
        const timer = new TimerInfo();
        timer.sid = target.sid;
        timer.isPrivate = target.isPrivate;
        timer.epId = target.epId;
        timer.set = Math.floor(Date.now() / 1000);
        timer.ruleId = spec.ruleId;
        timer.modeTag = spec.modeTag;
        timer.prompts = spec.prompts && spec.prompts.length > 0 ? [...spec.prompts] : undefined;
        if (spec.type === 'target') {
            timer.type = 'target';
            timer.target = spec.target || 0;
            timer.count = 1;
        } else {
            timer.type = 'interval';
            const interval = spec.interval || 0;
            timer.interval = interval;
            timer.target = timer.set + interval;
            timer.count = spec.count;
        }
        this.timerQueue.push(timer);
        this.saveTimerQueue();
        if (!this.intervalId) {
            log.info('定时器任务启动');
            this.executeTask();
        }
        log.info(`添加规则定时器 ${spec.ruleId}（${target.sid}，${timer.type}）`);
    }

    /** 取消某规则/模式的全部定时器（规则删除/停用/关闸/用尽） */
    static removeRuleTimers(ruleId: string) {
        const before = this.timerQueue.length;
        this.timerQueue = this.timerQueue.filter(timer => timer.ruleId !== ruleId);
        if (this.timerQueue.length !== before) this.saveTimerQueue();
    }

    /** 列出规则/模式定时器（不传 ruleId = 全部） */
    static listRuleTimers(ruleId?: string): TimerInfo[] {
        return this.timerQueue.filter(timer => !!timer.ruleId && (ruleId === undefined || timer.ruleId === ruleId));
    }

    /** 清除手动 set_timer 条目（ruleId 为空且非 activeTime/judgeWait）；返回删除数量并立即落盘 */
    static clearManualTimers(): number {
        const before = this.timerQueue.length;
        this.timerQueue = this.timerQueue.filter(timer =>
            !!timer.ruleId || timer.type === 'activeTime' || timer.type === 'judgeWait',
        );
        const removed = before - this.timerQueue.length;
        if (removed > 0) this.saveTimerQueue();
        return removed;
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
                // 触发域条目（ruleId 存在）：全权交给端口 handler（判闸/渲染 prompt/起轮/续期），
                // task 只负责到点分派；旧 target/interval 语义不再适用（避免双重消费）。
                if (timer.ruleId) {
                    try {
                        if (ownsTriggerTimer(timer)) await fireTriggerTimer(timer);
                        else log.warning(`规则定时器 ${timer.ruleId} 无触发域处理器，已跳过`);
                    } catch (e) {
                        log.exception(`${timer.sid} 执行规则定时器 ${timer.ruleId} 出错`, e);
                    }
                    continue;
                }
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
                            const session = getSessionById(sid);
                            // A12：合成 msg 无 rawId，回填同端点最近真实用户消息，开启「回复引用」时也能带 [CQ:reply]
                            applyLastMessageRef(session, ctx, msg);

                            const s = `Your timer fired. Send this reply:
Timer set at: ${fmtDate(set)}
Target time: ${fmtDate(target)}
Triggered at: ${fmtDate(Math.floor(Date.now() / 1000))}
Prompt: ${pickPrompt(timer.prompts) || content}`;

                            try {
                                await session.context.addSystemUserMessage(s, SYSTEM_NAME.timer);
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
                            const session = getSessionById(sid);
                            applyLastMessageRef(session, ctx, msg);

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

                            const s = `Your timer fired. Send this reply:
Timer set at: ${fmtDate(set)}
Interval: ${fmtDate(interval)}
Remaining triggers: ${count === -1 ? 'unlimited' : count - 1}
Triggered at: ${fmtDate(Math.floor(Date.now() / 1000))}
Prompt: ${pickPrompt(timer.prompts) || content}`;

                            await session.context.addSystemUserMessage(s, SYSTEM_NAME.timer);
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
                            const session = getSessionById(sid);
                            applyLastMessageRef(session, ctx, msg);

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
                            const lastTimePrompt = `Last message time: ${fmtDate(lastTime)}`;
                            const s = `It is now your active window: ${fmtDate(Math.floor(Date.now() / 1000))}
${lastTimePrompt}
Say something.`;

                            await session.context.addSystemUserMessage(s, SYSTEM_NAME.activeHours);
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
                            const ended = await finishJudgeWaitRound(timer.sid);
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

    /** 加载队列（M2 拆分：装配期 recover/reconcile 使用；start 前不动调度） */
    static loadQueue() {
        this.getTimerQueue();
    }

    /** 启动轮询（装配期在 reconcile 完成后调用） */
    static start() {
        this.executeTask();
    }

    static init() {
        this.loadQueue();
        this.start();
    }
}
// 把 judgeWait 定时器操作注册到 L0 端口：judge 评分轮末经端口安排/取消（避免 judge ↔ timer 互相 import）
setJudgeWaitScheduler({
    schedule: (ctx, session, target) => TimerManager.addJudgeWaitTimer(ctx, session, target),
    cancel: (sid) => TimerManager.removeTimers(sid, "", ["judgeWait"], []),
});
// 把规则/模式定时器的增删查注册到 L0 端口（方向 B）：触发域不 import timer，经此回调操作队列
setTriggerTimerScheduler({
    addRuleTimer: (target, spec) => TimerManager.addRuleTimer(target, spec),
    removeRuleTimers: (ruleId) => TimerManager.removeRuleTimers(ruleId),
    listRuleTimers: (ruleId) => TimerManager.listRuleTimers(ruleId),
});
