// 会话设定：按会话生效的触发/上下文参数（持久化，revive 按 validKeysMap 恢复）。
import { TypeDescriptor } from "../utils/revive";

export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo', 'regexTrigger', 'judge', 'overrides'];
    static validKeysMap: { [key in keyof Setting]?: TypeDescriptor<Setting[key]> } = {
        priv: 'number',
        standby: 'boolean',
        counter: 'number',
        timer: 'number',
        prob: 'number',
        regexTrigger: 'boolean',
        judge: 'boolean',
        activeTimeInfo: { objectValue: 'any' },
        overrides: { objectValue: 'any' }
    }
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
    regexTrigger: boolean;
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
        this.standby = false;
        this.counter = -1;
        this.timer = -1;
        this.prob = -1;
        this.regexTrigger = true;
        this.judge = false;
        this.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0
        }
        this.overrides = {};
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
