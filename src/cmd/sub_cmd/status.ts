// .ai status：查看当前会话 AI 状态（含 api连接 健康总览 + 触发域/判定观测）
import Config from "../../config/config";
import { JudgeManager } from "../../judge/judge_manager";
import Model from "../../model/model";
import { decisionSchedule } from "../../pipeline/decision_schedule";
import { getRuleStore, pendingDelays } from "../../trigger/runtime";
import { fmtDate } from "../../utils/string";
import { platformOf } from "../../utils/target_id";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

import { formatConnState } from "./model";

/** 触发域/判定观测块（任何未装配/异常都降级成一行提示，status 本体永不失败） */
function collectTriggerStatus(sid: string): string {
    try {
        const store = getRuleStore();
        const rules = store.list();
        const badRules = store.getBad().length;
        const pending = pendingDelays.list().filter(slot => slot.sessionId === sid).length;
        const schedule = decisionSchedule.stats();
        const judgeStats = JudgeManager.getSessionStats(sid);
        const judgeCfg = Config.trigger.JUDGE_VALID
            ? '有效'
            : `不可用（${(Config.trigger.JUDGE_ERRORS || [])[0] || '未配置'}）`;
        const waitLeft = judgeStats && judgeStats.waitUntil > Date.now()
            ? `${Math.ceil((judgeStats.waitUntil - Date.now()) / 1000)}s`
            : '无';
        const shadow = judgeStats?.lastShadow;
        const shadowText = shadow
            ? `${shadow.action}（旧=${shadow.legacy}）S=${shadow.S.toFixed(3)} 置信=${shadow.confidence} @${fmtDate(Math.floor(shadow.at / 1000))}`
            : '无';
        const budget = judgeStats
            ? `本小时 ${judgeStats.hourlyCount}/${Config.trigger.JUDGE.GATE.max_calls_per_hour} ｜ 精力 ${judgeStats.energy}`
            : `本小时 0/${Config.trigger.JUDGE.GATE.max_calls_per_hour} ｜ 精力 ${Config.trigger.JUDGE.ENERGY.initial}`;
        return `触发规则: ${rules.length} 条（损坏 ${badRules}）
        delay 挂起: ${pending} 条 ｜ 判定去抖/在飞: ${schedule.pending}/${schedule.inflight}
        ---- 判定（shadow 观测） ----
        判定配置: ${judgeCfg}
        判定预算: ${budget}
        WAIT 轮剩余: ${waitLeft}
        最近决策: ${shadowText}`;
    } catch (e) {
        return `观测不可用（${e instanceof Error ? e.message : String(e)}）`;
    }
}

export function registerCmdStatus() {
    const cmd = new SubCmd('status');
    cmd.desc = '查看当前AI状态';
    cmd.help = `帮助:
【.ai status】查看当前会话 AI 状态（平台/权限/上下文轮数/各触发模式/api连接状态/触发域与判定观测）`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, session, ret } = scc;
        const setting = session.setting;
        const { start, end, segs } = setting.activeTimeInfo;

        const states = Model.states;
        const active = states.filter(s => s.status !== 'ignored');
        const okCount = states.filter(s => s.status === 'ok').length;
        const connText = active.length === 0
            ? '未配置'
            : `${active.length} 条 · 可用 ${okCount}${states.some(s => s.status === 'error') ? ` · 失败 ${states.filter(s => s.status === 'error').length}` : ''}\n${active.map(formatConnState).join('\n')}`;

        const triggerText = collectTriggerStatus(sid);

        seal.replyToSender(ctx, msg, `${sid}
        平台: ${platformOf(ctx) || '未知'}
        会话类型: ${session.sessionType === 'user' ? '私聊' : '群聊'}
        模型(全局): ${Model.getChatModel('chat')?.name || '未配置'}
        模型连接: ${connText}
        权限: ${setting.priv}
        上下文轮数: ${session.context.messages.filter(m => m.role === 'user').length}
        AI 总闸(aiEnabled): ${setting.aiEnabled ? '开启' : '关闭'}
        非指令正则触发: ${setting.regexTrigger ? '开启' : '关闭'}
        @ 触发: ${setting.atTrigger ? '开启' : '关闭'}
        事件触发(e): ${setting.eventTrigger ? '开启' : '关闭'}
        计数器模式(c): ${setting.counter > -1 ? `${setting.counter}条` : '关闭'}
        延迟模式(d): ${setting.timer > -1 ? `${setting.timer}秒` : '关闭'}
        概率模式(p): ${setting.prob > -1 ? `${setting.prob}%` : '关闭'}
        timer 模式(t): ${setting.timerTrigger ? '开启' : '关闭'}
        活跃时间模式(a): ${setting.activeMode ? '开启' : '关闭'}
        评分触发(j): ${setting.judge ? '开启' : '关闭'}
        活跃时间段(旧): ${(start !== 0 || end !== 0) ? `${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}×${segs}` : '未设置'}

        ---- 触发域 ----
        ${triggerText}`);
        return ret;
    }
}
