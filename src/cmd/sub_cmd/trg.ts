// .ai trg：触发域单模式开关/规则/定时器统一入口。
//
// 方案 §8：`.ai trg` 总览；`<模式> on|off`；`all off`；`rule lst/rm/clr/set`；`timer lst/clr`。
// 模式元数据唯一来源 trigger_meta.MODES（字母序）；规则数据走 L2 trigger/runtime。
import Config from "../../config/config";
import { modeByToken, MODES } from "../../config/static_config/trigger_meta";
import type { ModeMeta } from "../../config/static_config/trigger_meta";
import { listRuleTimers } from "../../core/ports/trigger_timer";
import { syncModeTimers } from "../../session/mode_timers";
import type { Session } from "../../session/session";
import { TimerManager } from "../../timer";
import { ruleWakePrompts, summarizeGates } from "../../trigger";
import type { TriggerRule } from "../../trigger";
import { getRuleStore, pendingDelays } from "../../trigger/runtime";
import { fmtDate } from "../../utils/string";
import { I, U } from "../privilege";
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
    return `触发模式总览（${session.sessionId}）｜AI 总闸：${session.setting.aiEnabled ? '开' : '关'}\n${lines.join('\n')}\n\n切换：.ai trg <模式> on|off ｜ 规则：.ai trg rule`;
}

/** 解析可选的数值参数（如 `.ai trg counter on 5`） */
function optionalNumber(args: string[]): number | null {
    for (const arg of args) {
        const value = Number(arg);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function modeDetail(session: Session, mode: ModeMeta): string {
    const aliases = mode.aliases.length > 0 ? mode.aliases.join('/') : '-';
    return `${mode.token}（别名 ${aliases}）｜${mode.label}\n${mode.desc}\n当前：${describeMode(session, mode)}`;
}

function allModesOff(session: Session): string {
    const setting = session.setting;
    setting.regexTrigger = false;
    setting.eventTrigger = false;
    setting.atTrigger = false;
    setting.counter = -1;
    setting.timer = -1;
    setting.prob = -1;
    setting.judge = false;
    setting.activeMode = false;
    setting.timerTrigger = false;
    if (session.context.timer) clearTimeout(session.context.timer);
    session.context.timer = null;
    TimerManager.removeTimers(session.sessionId, '', ['activeTime'], []);
    syncModeTimers(session);
    return '全部单触发模式已关闭（链规则未动；规则请用 .ai trg rule）';
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
            if (!specs.VALID) return '「默认定时器」TOML 非法，无法开启 timer 模式；请修正配置并重载 JS。';
            setting.timerTrigger = true;
            const count = syncModeTimers(session);
            return count > 0 ? `timer 模式：开(${count}个计划)` : 'timer 模式：开，但「默认定时器」为空，不会触发。';
        }
        default:
            return '未知模式';
    }
}

function ruleScopeFilter(session: Session, scopeArg: string): TriggerRule[] {
    const sid = session.sessionId;
    return getRuleStore().list().filter(rule => {
        const sessions = rule.scope.sessions || [];
        if (scopeArg === 'all') return true;
        if (scopeArg === 'global') return sessions.length === 0;
        return sessions.includes(sid);
    });
}

function ruleListText(session: Session, scopeArg: string, page: number): string {
    const sid = session.sessionId;
    const filtered = ruleScopeFilter(session, scopeArg === 'global' || scopeArg === 'all' ? scopeArg : 'current');
    if (filtered.length === 0) return '没有匹配的门控链规则';
    const safePage = Math.max(1, page);
    const items = filtered.slice((safePage - 1) * 10, safePage * 10).map(rule => {
        const state = getRuleStore().readState(rule.id)[sid];
        const fired = state?.fired ?? 0;
        const max = rule.limits.max_triggers === -1 ? '无限' : String(rule.limits.max_triggers);
        const sessions = rule.scope.sessions || [];
        const scope = sessions.length > 0 ? (sessions.length === 1 ? sessions[0] : `${sessions.length}会话`) : '全局';
        const next = listRuleTimers(rule.id)[0]?.target;
        return `${rule.id} ｜ ${summarizeGates(rule.gates)} ｜ 唤醒${ruleWakePrompts(rule).length}条 ｜ ${fired}/${max} ｜ ${scope}`
            + (rule.limits.expire_at > 0 ? ` ｜ 到期${fmtDate(Math.floor(rule.limits.expire_at / 1000))}` : '')
            + (state?.lastFiredAt ? ` ｜ 上次${fmtDate(Math.floor(state.lastFiredAt / 1000))}` : '')
            + (next ? ` ｜ 下次${fmtDate(next)}` : '');
    });
    const pages = Math.ceil(filtered.length / 10);
    return `门控链规则（${filtered.length} 条，第 ${safePage}/${pages} 页）：\n${items.join('\n')}`;
}

function removeRuleEverywhere(rule: TriggerRule): boolean {
    TimerManager.removeRuleTimers(rule.id);
    pendingDelays.cancelRule(rule.id);
    return getRuleStore().remove(rule.id);
}

function ruleRemove(session: Session, ids: string[]): string {
    if (ids.length === 0) return '用法：.ai trg rule rm <规则ID...>';
    let removed = 0;
    for (const id of ids) {
        const rule = getRuleStore().getById(id);
        if (!rule) continue;
        const sessions = rule.scope.sessions || [];
        if (sessions.length > 0 && !sessions.includes(session.sessionId)) continue;
        if (removeRuleEverywhere(rule)) removed++;
    }
    return removed > 0 ? `已删除 ${removed} 条规则（含定时器与 delay 挂起）` : '未删除任何规则（id 不存在或不属于本会话）';
}

function ruleClear(session: Session, confirmed: boolean): string {
    if (!confirmed) return '清空规则需要确认：.ai trg rule clr --yes';
    let removed = 0;
    for (const rule of ruleScopeFilter(session, 'current')) {
        if (removeRuleEverywhere(rule)) removed++;
    }
    return `已清空本会话 ${removed} 条规则`;
}

function ruleSetWake(session: Session, id: string, wake: string): string {
    if (!id) return '用法：.ai trg rule set <规则ID> --wake=唤醒词';
    if (!wake) return '请用 --wake=唤醒词 指定新唤醒词';
    const store = getRuleStore();
    const rule = store.getById(id);
    if (!rule) return `规则不存在：${id}`;
    const sessions = rule.scope.sessions || [];
    if (sessions.length > 0 && !sessions.includes(session.sessionId)) return '只能修改本会话规则的唤醒词';
    rule.wake_prompts = [wake];
    store.upsert(rule);
    return `已更新规则 ${id} 的唤醒词（1 条）`;
}

function timerListText(session: Session, page: number): string {
    const timers = TimerManager.getTimers(session.sessionId, '', []);
    if (timers.length === 0) return '本会话没有定时器条目';
    const safePage = Math.max(1, page);
    const items = timers.slice((safePage - 1) * 10, safePage * 10).map((timer, index) => {
        const no = index + 1 + (safePage - 1) * 10;
        const owner = timer.ruleId ? `规则${timer.ruleId}` : '手动';
        const detail = timer.type === 'target' ? fmtDate(timer.target) : `${timer.interval}秒×${timer.count === -1 ? '无限' : timer.count}`;
        return `${no}. ${timer.type}｜${owner}｜${detail}`;
    });
    const pages = Math.ceil(timers.length / 10);
    return `定时器（${timers.length} 条，第 ${safePage}/${pages} 页）：\n${items.join('\n')}`;
}

function timerClear(): string {
    const removed = TimerManager.clearManualTimers();
    return removed > 0 ? `已清除 ${removed} 个手动定时器（规则/模式条目保留）` : '没有可清除的手动定时器';
}

export function registerCmdTrg() {
    const cmd = new SubCmd('trg');
    cmd.desc = '触发域模式开关/规则/定时器总览';
    cmd.help = `帮助:
【.ai trg】查看总闸与 9 个单触发模式状态
【.ai trg <模式>】模式详情
【.ai trg <模式> on|off [值]】切换单个模式（不含链规则）
【.ai trg all off】关闭全部单触发（不动链规则）
【.ai trg rule lst [current|global|all] [--page=N]】门控链规则列表
【.ai trg rule rm <id...>】删除规则
【.ai trg rule clr --yes】清空本会话规则
【.ai trg rule set <id> --wake=唤醒词】改唤醒词
【.ai trg timer lst [--page=N]】本会话定时器条目
【.ai trg timer clr】清除手动定时器（规则条目保留）

<模式>（按字母序）:
active 活跃时间 / at 被@ / counter 计数器 / delay 延迟 / event 事件
judge 评分 / prob 概率 / regex 正则 / timer 定时器

【.ai trg counter on 5】【.ai trg timer on】`;
    cmd.priv = {
        priv: U,
        args: {
            rule: { priv: U, args: { lst: { priv: U }, rm: { priv: I }, clr: { priv: I }, set: { priv: I } } },
            timer: { priv: I, args: { lst: { priv: I }, clr: { priv: I } } },
            all: { priv: I },
            active: { priv: I }, at: { priv: I }, counter: { priv: I }, delay: { priv: I }, event: { priv: I },
            judge: { priv: I }, prob: { priv: I }, regex: { priv: I },
        },
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const args = ((cmdArgs.args || []) as string[]).slice(1).map(item => String(item || '').trim()).filter(Boolean);
        const reply = (text: string): seal.CmdExecuteResult => {
            session.save();
            seal.replyToSender(ctx, msg, text);
            return ret;
        };
        const kwarg = (name: string): string => {
            const found = cmdArgs.kwargs.find(item => item.name === name);
            return found && found.valueExists ? String(found.value || '').trim() : '';
        };
        const hasFlag = (name: string): boolean => cmdArgs.kwargs.some(item => item.name === name && !item.valueExists);
        const page = Math.max(1, parseInt(kwarg('page')) || 1);
        const head = (args[0] || '').toLowerCase();

        if (!head || head === 'status') return reply(overview(session));
        if (head === 'all') {
            if ((args[1] || '').toLowerCase() !== 'off') return reply('用法：.ai trg all off');
            return reply(allModesOff(session));
        }
        if (head === 'rule') {
            const sub = (args[1] || 'lst').toLowerCase();
            if (sub === 'lst') return reply(ruleListText(session, (args[2] || 'current').toLowerCase(), page));
            if (sub === 'rm') return reply(ruleRemove(session, args.slice(2)));
            if (sub === 'clr') return reply(ruleClear(session, hasFlag('yes')));
            if (sub === 'set') return reply(ruleSetWake(session, args[2] || '', kwarg('wake')));
            return reply('用法：.ai trg rule lst|rm|clr|set');
        }
        if (head === 'timer') {
            const sub = (args[1] || 'lst').toLowerCase();
            if (sub === 'lst') return reply(timerListText(session, page));
            if (sub === 'clr') return reply(timerClear());
            return reply('用法：.ai trg timer lst|clr');
        }
        const mode = modeByToken(args[0]);
        if (!mode) return reply(`未知模式：${args[0]}\n可用：${MODES.map(item => item.token).join(' / ')}`);
        if (args.length === 1) return reply(modeDetail(session, mode));
        const action = (args[1] || '').toLowerCase();
        if (action !== 'on' && action !== 'off') return reply(`用法：.ai trg ${mode.token} on|off`);
        if (action === 'on' && !session.setting.aiEnabled) return reply('请先 .ai on 打开 AI 总闸');
        return reply(toggleMode(session, mode, action === 'on', args.slice(2)));
    };
}
