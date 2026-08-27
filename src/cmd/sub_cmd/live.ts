// .ai live：查看会话实时运行状态（单会话 / 全局总览）
import Agent from "../../agent/agent";
import { Session } from "../../session/session";
import { TimerManager } from "../../timer";
import { requestLimiter } from "../../utils/concurrency";
import { aliasToCmd } from "../../utils/utils";
import { M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

type QueueInfo = ReturnType<typeof requestLimiter.getQueueInfo>;

/** 会话当前运行状态文本（流式优先于运行中，运行中优先于排队） */
function stateText(session: Session, qi: QueueInfo): string {
    if (session.stream.id && session.stream.toolCallStatus) return '流式-工具调用中';
    if (session.stream.id) return '流式输出中';
    if (session.activeRuns > 0) return `运行中(${session.activeRuns}个请求)`;
    if (qi.queuedBySession > 0) return '排队中';
    return '空闲';
}

/** 汇总单个会话的运行时只读信息（不触发任何副作用） */
function collectRuntime(session: Session): {
    state: string;
    activeRuns: number;
    queued: number;
    timers: { target: number; interval: number; activeTime: number };
} {
    const qi = requestLimiter.getQueueInfo(session.sessionId);
    const timers = { target: 0, interval: 0, activeTime: 0 };
    for (const t of TimerManager.getTimers(session.sessionId)) {
        if (t.type === 'target' || t.type === 'interval' || t.type === 'activeTime') timers[t.type]++;
    }
    return {
        state: stateText(session, qi),
        activeRuns: session.activeRuns,
        queued: qi.queuedBySession,
        timers
    };
}

function timerText(timers: { target: number; interval: number; activeTime: number }): string {
    const parts: string[] = [];
    if (timers.target > 0) parts.push(`目标${timers.target}`);
    if (timers.interval > 0) parts.push(`间隔${timers.interval}`);
    if (timers.activeTime > 0) parts.push(`活跃时间${timers.activeTime}`);
    return parts.length > 0 ? parts.join(' ') : '无';
}

/** 单会话视图：.ai live */
function formatRuntime(session: Session): string {
    const r = collectRuntime(session);
    const qi = requestLimiter.getQueueInfo(session.sessionId);
    const sessionType = session.sessionType === 'user' ? '私聊' : '群聊';
    return [
        `【运行状态】${sessionType}会话 ${session.sessionId}`,
        `状态: ${r.state}`,
        `流式: ${session.stream.id ? (session.stream.toolCallStatus ? '工具调用中' : '输出中') : '无'}`,
        `并发: 全局活跃 ${qi.active}/${qi.maxConcurrent} | 本会话活跃 ${r.activeRuns} | 本会话排队 ${r.queued}/${qi.maxQueue}`,
        `定时器: ${timerText(r.timers)}`
    ].join('\n');
}

/** 是否有可展示的运行中状态（含待触发定时器） */
function isBusy(session: Session): boolean {
    if (session.stream.id) return true;
    if (session.activeRuns > 0) return true;
    if (requestLimiter.getQueueInfo(session.sessionId).queuedBySession > 0) return true;
    return TimerManager.getTimers(session.sessionId).length > 0;
}

/** 全局视图：.ai live all（仅骰主可用；只列活跃会话，避免会话多时刷屏） */
function formatAll(): string {
    const qi = requestLimiter.getQueueInfo();
    const sessions: Session[] = [];
    const seen = new Set<string>();
    for (const agent of Agent.listAgents()) {
        for (const session of agent.sessionService.listSessions()) {
            const key = `${agent.name}\u0000${session.sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sessions.push(session);
        }
    }

    const busy = sessions.filter(isBusy);
    const idle = sessions.length - busy.length;
    const lines = [
        `【全局运行总览】已加载会话 ${sessions.length} 个（活跃 ${busy.length} / 空闲 ${idle}）`,
        `并发: 全局活跃 ${qi.active}/${qi.maxConcurrent} | 排队 ${qi.queued}/${qi.maxQueue}`
    ];
    if (busy.length === 0) {
        lines.push('当前没有活跃会话');
        return lines.join('\n');
    }
    for (const session of busy) {
        const r = collectRuntime(session);
        const sessionType = session.sessionType === 'user' ? '私聊' : '群聊';
        const timerCount = r.timers.target + r.timers.interval + r.timers.activeTime;
        const suffix = [
            r.queued > 0 ? `排队${r.queued}` : '',
            timerCount > 0 ? `定时器:${timerText(r.timers)}` : ''
        ].filter(Boolean).join(' ');
        lines.push(`[${session.sessionId}] ${sessionType} ${r.state}${suffix ? ' ' + suffix : ''}`);
    }
    return lines.join('\n');
}

export function registerCmdLive() {
    const cmd = new SubCmd('live');
    cmd.desc = '查看会话实时运行状态';
    cmd.help = `帮助:
【.ai live】查看当前会话实时运行状态（运行/流式/排队/定时器）
【.ai live all】查看全局活跃会话总览（骰主）`;
    cmd.priv = {
        priv: U, args: {
            all: { priv: M }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const val2 = aliasToCmd(cmdArgs.getArgN(2));
        if (!val2) {
            seal.replyToSender(ctx, msg, formatRuntime(session));
            return ret;
        }
        if (val2 === 'all') {
            seal.replyToSender(ctx, msg, formatAll());
            return ret;
        }
        seal.replyToSender(ctx, msg, cmd.help);
        return ret;
    };
}