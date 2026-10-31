// 会话设定：按会话生效的触发/上下文参数（持久化，revive 按 validKeysMap 恢复）。
import { TypeDescriptor } from "../utils/revive";

export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'aiEnabled', 'activeMode', 'timerTrigger', 'counter', 'timer', 'prob', 'activeTimeInfo', 'regexTrigger', 'eventTrigger', 'judge', 'overrides'];
    static validKeysMap: { [key in keyof Setting]?: TypeDescriptor<Setting[key]> } = {
        priv: 'number',
        // 绝对触发闸：新会话默认关（Q3）；旧存档 standby=true 由 SessionService 迁移
        aiEnabled: 'boolean',
        // 会话级活跃时间开关（默认关；全局时段由「触发活跃时间」提供）
        activeMode: 'boolean',
        // 被 @ 触发开关（默认开，R17）
        // timer 单模式开关（配置驱动；默认关）
        timerTrigger: 'boolean',
        counter: 'number',
        timer: 'number',
        prob: 'number',
        regexTrigger: 'boolean',
        eventTrigger: 'boolean',
        judge: 'boolean',
        activeTimeInfo: { objectValue: 'any' },
        overrides: { objectValue: 'any' }
    }
    priv: number;
    aiEnabled: boolean;
    activeMode: boolean;
    timerTrigger: boolean;
    counter: number;
    timer: number;
    prob: number;
    regexTrigger: boolean;
    eventTrigger: boolean;
    judge: boolean;
    activeTimeInfo: {
        start: number;
        end: number;
        segs: number;
    }
    /**
     * 按会话覆盖的上下文参数（P2-1）：未设置时用全局配置。
     * 0/undefined 一律视为"未覆盖"（与全局配置的 0 语义区分：这里 0 不是"关闭"，而是"没设"）。
     */
    overrides: {
        coldWindowChars?: number;
        coldTruncate?: number;
        windowMaxChars?: number;
    }

    constructor() {
        this.priv = 0;
        // 绝对触发闸：新会话默认关（Q3）；旧存档由 SessionService 迁移 standby=true → true
        this.aiEnabled = false;
        this.activeMode = false;
        this.timerTrigger = false;
        this.counter = -1;
        this.timer = -1;
        this.prob = -1;
        this.regexTrigger = true;
        this.eventTrigger = true;
        this.judge = false;
        this.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0
        }
        this.overrides = {};
    }

    /**
     * 绝对触发闸（standby 概念已删除：aiEnabled 即唯一开关）。
     * 保留方法名是为了让旧调用点迁移期不用一次性改完，语义等同 `this.aiEnabled`。
     */
    enabled(): boolean {
        return this.aiEnabled;
    }

    /**
     * 旧存档 standby → aiEnabled 迁移：必须传原始 JSON 里的 setting（revive 会按新 validKeysMap
     * 丢弃 standby），revive 后调用；旧版 .ai on 会置 standby=true（=AI 开启）。
     */
    static applyLegacyStandby(rawSetting: unknown, setting: Setting): void {
        if (!rawSetting || typeof rawSetting !== 'object') return;
        if ((rawSetting as { standby?: unknown }).standby === true && !setting.aiEnabled) setting.aiEnabled = true;
    }

    /**
     * 解析"按会话覆盖 → 全局配置"（P2-1）：`key` 在本会话设了正数就用它，否则用 `fallback`。
     * 只接受正数：0/负数/非数字一律视为"未覆盖"，避免与全局配置里"0=关闭/不限"的语义混淆
     * （例如 `窗口上限字数=0` 表示"不移出"，但按会话设 0 只应表示"没设过"）。
     */
    overrideOr(key: 'coldWindowChars' | 'coldTruncate' | 'windowMaxChars', fallback: number): number {
        const v = this.overrides ? this.overrides[key] : undefined;
        return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
    }
}
