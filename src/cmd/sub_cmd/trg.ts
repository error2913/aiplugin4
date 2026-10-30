// .ai trg：触发域单模式开关（9 模式统一入口）。
//
// 方案 §8：`.ai trg` 无参=总览；`.ai trg <模式> on|off` 单模式切换；
// `.ai trg status` 与无参等价。模式元数据唯一来源 trigger_meta.MODES（字母序）。
import Config from "../../config/config";
import { modeByToken, MODES } from "../../config/static_config/trigger_meta";
import type { ModeMeta } from "../../config/static_config/trigger_meta";
import { syncModeTimers } from "../../session/mode_timers";
import type { Session } from "../../session/session";
import { TimerManager } from "../../timer";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";


/** 模式当前状态文本 */
function describeMode(session: Session, mode: ModeMeta): string {
    const setting = session.setting;
    switch (mode.token) {
        case 'active':
            return setting.activeMode ? '开' : '关';
        case 'at':
            return setting.atTrigger ? '开' : '关';
        case 'counter':
            return setting.counter > -1 ? `开(${setting.counter})` : '关';
        case 'delay':
            return setting.timer > -1 ? `开(${setting.timer}s)` : '关';
        case 'event':
            return setting.eventTrigger ? '开' : '关';
        case 'judge':
            return setting.judge ? '开' : '关';
        case 'prob':
            return setting.prob > -1 ? `开(${setting.prob}%)` : '关';
        case 'regex':
            return setting.regexTrigger ? '开' : '关';
        case 'timer': {
            if (!setting.timerTrigger) return '关';
            const specs = Config.trigger.TIMER_SPECS;
            return specs.VALID ? `开(${specs.SPECS.length}个计划)` : '开(配置非法)';
        }
        default:
            return '关';
    }
}

function overview(session: Session): string {
    const lines = MODES.map(mode => `${mode.token}${mode.aliases.length && mode.token !== 'at' ? `(${mode.aliases[0]})` : ''} ${mode.label}：${describeMode(session, mode)}`);
    return `触发模式总览（${session.sessionId}）\n${lines.join('\n')}\n\n切换：.ai trg <模式> on|off`;
}

/** 解析可选的数值参数（如 `.ai trg counter on 5`） */
function optionalNumber(args: string[]): number | null {
    for (const arg of args) {
        const value = Number(arg);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function toggleMode(session: Session, mode: ModeMeta, enable: boolean, args: string[]): string {
    const setting = session.setting;
    const sid = session.sessionId;
    switch (mode.token) {
        case 'active':
            setting.activeMode = enable;
            if (!enable) TimerManager.removeTimers(sid, '', ['activeTime'], []);
            if (enable && Config.trigger.ACTIVE_TIME_SEGMENTS.length === 0) {
                return '活跃时间模式已开启，但「触发活跃时间」为空，不会触发；请先在配置页填写时段。';
            }
            return `活跃时间模式：${enable ? '开' : '关'}`;
        case 'at':
            setting.atTrigger = enable;
            return `@ 触发：${enable ? '开' : '关'}`;
        case 'counter': {
            if (!enable) {
                setting.counter = -1;
                return '计数器模式：关';
            }
            const value = optionalNumber(args);
            session.context.counter = 0;
            setting.counter = value !== null && Number.isInteger(value) && value > 0 ? value : Config.trigger.COUNTER;
            return `计数器模式：开(${setting.counter}条)`;
        }
        case 'delay': {
            if (!enable) {
                if (session.context.timer) clearTimeout(session.context.timer);
                session.context.timer = null;
                setting.timer = -1;
                return '延迟模式：关';
            }
            const value = optionalNumber(args);
            setting.timer = value !== null && value > 0 ? value : Config.trigger.TIMER;
            return `延迟模式：开(${setting.timer}s)`;
        }
        case 'event':
            setting.eventTrigger = enable;
            return `事件触发：${enable ? '开' : '关'}`;
        case 'judge':
            setting.judge = enable;
            return `评分触发：${enable ? '开' : '关'}`;
        case 'prob': {
            if (!enable) {
                setting.prob = -1;
                return '概率模式：关';
            }
            const value = optionalNumber(args);
            setting.prob = value !== null && value >= 0 && value <= 100 ? value : Config.trigger.PROBABILITY;
            return `概率模式：开(${setting.prob}%)`;
        }
        case 'regex':
            setting.regexTrigger = enable;
            return `正则触发：${enable ? '开' : '关'}`;
        case 'timer': {
            if (!enable) {
                setting.timerTrigger = false;
                syncModeTimers(session);
                return 'timer 模式：关';
            }
            const specs = Config.trigger.TIMER_SPECS;
            if (!specs.VALID) {
                return '「默认定时器」TOML 非法，无法开启 timer 模式；请修正配置并重载 JS。';
            }
            setting.timerTrigger = true;
            const count = syncModeTimers(session);
            return count > 0 ? `timer 模式：开(${count}个计划)` : 'timer 模式：开，但「默认定时器」为空，不会触发。';
        }
        default:
            return '未知模式';
    }
}

export function registerCmdTrg() {
    const cmd = new SubCmd('trg');
    cmd.desc = '触发域模式开关总览';
    cmd.help = `帮助:
【.ai trg】查看 9 个单触发模式当前状态
【.ai trg <模式> on|off】切换单个模式（不含链规则）

<模式>（按字母序）:
active 活跃时间 / at 被@ / counter 计数器 / delay 延迟 / event 事件
judge 评分 / prob 概率 / regex 正则 / timer 定时器

【.ai trg counter on 5】开启计数器并设阈值 5
【.ai trg timer on】按全局「默认定时器」开启 timer 模式`;
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const args = ((cmdArgs.args || []) as string[]).slice(1).map(item => String(item || '').trim()).filter(Boolean);
        if (args.length === 0 || args[0].toLowerCase() === 'status') {
            seal.replyToSender(ctx, msg, overview(session));
            return ret;
        }
        const mode = modeByToken(args[0]);
        if (!mode) {
            seal.replyToSender(ctx, msg, `未知模式：${args[0]}\n可用：${MODES.map(item => item.token).join(' / ')}`);
            return ret;
        }
        const action = (args[1] || 'on').toLowerCase();
        if (action !== 'on' && action !== 'off') {
            seal.replyToSender(ctx, msg, `用法：.ai trg ${mode.token} on|off`);
            return ret;
        }
        const text = toggleMode(session, mode, action === 'on', args.slice(2));
        session.save();
        seal.replyToSender(ctx, msg, text);
        return ret;
    };
}
