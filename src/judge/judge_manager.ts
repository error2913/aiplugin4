// 评分触发管理（裁剪版）：
// - 消息到达（IDLE）→ 立即评分一次 → SPEAK 回复 / WAIT 不回复；
// - 评分结果后进入 30s WAIT 挂起窗口，期间新消息只挂起最新一条，不调模型；
// - WAIT 到点后只对挂起消息评分一次；
// - 没有 shadow/IGNORE/预筛/预算/精力/活跃时间/忙/密度等额外闸门。
import Config from "../config/config";
import { getAuxLlm } from "../core/ports/aux_llm";
import { cancelJudgeWait, scheduleJudgeWait, setJudgeWaitFinisher } from "../core/ports/judge_wait";
import { logger } from "../logger";
import type { Session } from "../session/session";
import { writeWakeMarker } from "../trigger/wake";
import { buildContent, getRoleSetting } from "../utils/message";
import { fmtDate } from "../utils/string";
import { withTimeout } from "../utils/timeout";
import { truncateMiddleToTokenBudget } from "../utils/token_budget";
import { estimateTextTokens } from "../utils/token_estimate";

import { type JudgeDecisionConfigV2 } from "./config";
import { extractFeatures } from "./features";
import type { JudgeContextMessage, JudgeDims as JudgeFeatureDims, JudgeFeatures } from "./features";
import { parseScores } from "./parse";
import { decide, mergeDims } from "./policy";
import type { DecideResult } from "./policy";
import { buildJudgeMessages, type BuildJudgePromptInput, buildSystemOnePayload } from "./prompt";
import { parseSystemOneAnswers } from "./systemone";

const log = logger.withTag('judge');

/** 内存状态上限（LRU 淘汰最久未使用的会话） */
const MAX_STATES = 1000;
/** 当前候选消息注入 prompt 的 token 上限 */
const CANDIDATE_MAX_TOKENS = 600;
/** 特征时间线窗口（10 分钟） */
const TIMELINE_WINDOW_MS = 10 * 60 * 1000;

/** 判定触发源（message=新消息；wait=WAIT 到点重评挂起消息） */
export type JudgeSource = 'message' | 'wait';

/** WAIT 窗口内挂起的最新一条候选 */
interface PendingJudgeMessage {
    ctx: seal.MsgContext;
    msg: seal.Message;
    text: string;
    session: Session;
    source: JudgeSource;
    addressed: boolean;
}

/** 最近一次判定结论（.ai status 观测用；不持久化） */
interface JudgeLastDecision {
    at: number;
    action: string;
    S: number;
    U: number;
    reason: string;
    source: string;
    backend?: 'chat' | 'decision';
}

interface JudgeState {
    /** WAIT 窗口截止时间戳（毫秒）；0 = 空闲 */
    waitUntil: number;
    /** WAIT 窗口内到达的最新一条消息 */
    pending: PendingJudgeMessage | null;
    /** 10 分钟消息时间线（特征用） */
    timeline: { time: number; senderId?: string }[];
    /** 最近一次判定结论 */
    lastDecision?: JudgeLastDecision;
}

/** 一次评分的结果（副作用由调用方执行） */
interface JudgeOnceOutcome {
    decision: DecideResult;
    features: JudgeFeatures;
    dims: JudgeFeatureDims;
    reason: string;
    backend: 'chat' | 'decision';
    failed: boolean;
    missingModel: boolean;
    historyCount: number;
    historyTokens: number;
    costMs: number;
}

export class JudgeManager {
    private static states = new Map<string, JudgeState>();
    /**
     * 会话判定代际：.ai off / .ai stop / judge off / LRU 淘汰都会自增。
     * 在飞判定返回后若代际变化，直接丢弃结果。
     */
    private static generations = new Map<string, number>();
    /** 配置无效告警节流（毫秒时间戳；仅内存） */
    private static lastConfigWarnAt = 0;

    private static generationOf(sid: string): number {
        return this.generations.get(sid) ?? 0;
    }

    /** 取（或创建）会话 judge 状态；Map 按插入序，命中重插实现 LRU */
    private static ensureState(sid: string): JudgeState {
        let state = this.states.get(sid);
        if (state) {
            this.states.delete(sid);
            this.states.set(sid, state);
            return state;
        }
        state = {
            waitUntil: 0,
            pending: null,
            timeline: [],
        };
        this.states.set(sid, state);
        if (this.states.size > MAX_STATES) {
            const oldest = this.states.keys().next().value as string | undefined;
            if (oldest) this.clearSession(oldest);
        }
        return state;
    }

    /** 清理会话 judge 状态：移除内存状态与 WAIT 轮末定时器 */
    static clearSession(sid: string): void {
        this.generations.set(sid, this.generationOf(sid) + 1);
        this.states.delete(sid);
        cancelJudgeWait(sid);
    }

    /** 会话 AI 总闸；测试/裁剪桩可能没有 setting，缺失时按未闸处理 */
    private static aiEnabled(session: Session): boolean {
        const setting = (session as unknown as { setting?: { enabled?: () => boolean } }).setting;
        return typeof setting?.enabled === 'function' ? setting.enabled() : true;
    }

    /**
     * 主入口：消息 / WAIT 到点。
     * - WAIT 中：只挂起最新一条，不调模型；
     * - IDLE：立即评分。
     */
    static async evaluate(
        ctx: seal.MsgContext,
        msg: seal.Message,
        session: Session,
        messageText: string,
        options: { source?: JudgeSource; addressed?: boolean; senderId?: string } = {},
    ): Promise<void> {
        const sid = session.sessionId;
        if (!Config.trigger.JUDGE_VALID) {
            const now = Date.now();
            if (now - this.lastConfigWarnAt > 5 * 60 * 1000) {
                this.lastConfigWarnAt = now;
                const errors = (Config.trigger.JUDGE_ERRORS || []).join('；');
                log.error('评分触发参数无效，判定功能不可用：' + (errors || '未知原因') + '（其它触发照常）');
            }
            return;
        }
        if (!this.aiEnabled(session)) {
            log.debug('sid=' + sid + ' 会话 AI 已关闭，跳过判定');
            return;
        }
        const judgeOn = (session as unknown as { setting?: { judge?: boolean } }).setting?.judge;
        if (judgeOn === false) {
            log.debug('sid=' + sid + ' 评分触发已关闭，跳过判定');
            return;
        }

        const cfg = Config.trigger.JUDGE;
        const state = this.ensureState(sid);
        const source: JudgeSource = options.source || 'message';
        const addressed = options.addressed === true;
        const from = options.senderId || ctx.player?.userId || '';
        const now = Date.now();

        if (source === 'message') {
            state.timeline.push({ time: now, senderId: from });
            const cutoff = now - TIMELINE_WINDOW_MS;
            if (state.timeline.length > 0 && state.timeline[0].time <= cutoff) {
                state.timeline = state.timeline.filter(item => item.time > cutoff);
            }
        }

        // WAIT 窗口内：只挂起最新一条，不调模型
        if (now < state.waitUntil) {
            state.pending = { ctx, msg, text: messageText, session, source, addressed };
            log.info('sid=' + sid + ' msg="' + messageText + '" from=' + from + ' WAIT中 挂起消息 截止' + fmtDate(Math.floor(state.waitUntil / 1000)));
            return;
        }

        // 轮已到点但定时器兜底尚未触发：先补跑轮末挂起消息，再处理当前消息
        if (state.pending) {
            await this.endWaitRound(sid);
            const after = this.ensureState(sid);
            if (Date.now() < after.waitUntil) {
                after.pending = { ctx, msg, text: messageText, session, source, addressed };
                log.info('sid=' + sid + ' msg="' + messageText + '" from=' + from + ' 补跑后进入新WAIT 挂起消息 截止' + fmtDate(Math.floor(after.waitUntil / 1000)));
                return;
            }
        }

        const generation = this.generationOf(sid);
        await this.judgeMessage(ctx, msg, session, messageText, cfg, source, addressed, generation);
    }

    /** WAIT 结束：把轮内挂起的最新一条重新评分。返回是否已结束本轮 */
    static async endWaitRound(sid: string): Promise<boolean> {
        const state = this.states.get(sid);
        if (!state) return true;
        if (Date.now() < state.waitUntil) {
            log.info('会话<' + sid + '> WAIT未到点，定时器重新入队等下一轮');
            return false;
        }
        state.waitUntil = 0;
        const pending = state.pending;
        state.pending = null;
        if (!pending) {
            log.info('会话<' + sid + '> WAIT结束，无挂起消息');
            return true;
        }
        log.info('会话<' + sid + '> WAIT结束，评分挂起消息');
        await this.evaluate(pending.ctx, pending.msg, pending.session, pending.text, {
            source: pending.source === 'message' ? 'wait' : pending.source,
            addressed: pending.addressed,
        });
        return true;
    }

    /** 进入 WAIT：固定 wait_cooldown 秒，不清 pending */
    private static startWaitRound(ctx: seal.MsgContext, session: Session, tag: string): void {
        const cfg = Config.trigger.JUDGE;
        const state = this.ensureState(session.sessionId);
        const now = Date.now();
        if (cfg.SCORING.wait_cooldown <= 0) {
            state.waitUntil = 0;
            state.pending = null;
            log.info('会话<' + session.sessionId + '> ' + tag + ' wait_cooldown=0 不进入WAIT');
            return;
        }
        state.waitUntil = now + cfg.SCORING.wait_cooldown * 1000;
        this.startWaitTimer(ctx, session);
        log.info('会话<' + session.sessionId + '> ' + tag + ' 进入WAIT ' + cfg.SCORING.wait_cooldown + 's 截止' + fmtDate(Math.floor(state.waitUntil / 1000)));
    }

    /** 用内置定时器注册 WAIT 到点兜底触发（一次性） */
    private static startWaitTimer(ctx: seal.MsgContext, session: Session): void {
        if (Config.trigger.JUDGE.SCORING.wait_cooldown <= 0) return;
        cancelJudgeWait(session.sessionId);
        const target = Math.floor(Date.now() / 1000) + Config.trigger.JUDGE.SCORING.wait_cooldown;
        scheduleJudgeWait(ctx, session, target);
    }

    /** 会话被其他方式触发（回复）后进入 WAIT 30s */
    static noteSessionTrigger(ctx: seal.MsgContext, session: Session, reason: string): void {
        if (!Config.trigger.JUDGE_VALID) return;
        const state = this.ensureState(session.sessionId);
        const cfg = Config.trigger.JUDGE;
        const now = Date.now();
        if (cfg.SCORING.wait_cooldown <= 0) {
            state.waitUntil = 0;
            state.pending = null;
            log.info('会话<' + session.sessionId + '> 被触发(' + reason + ')，wait_cooldown=0 不进入WAIT');
            return;
        }
        state.waitUntil = now + cfg.SCORING.wait_cooldown * 1000;
        this.startWaitTimer(ctx, session);
        log.info('会话<' + session.sessionId + '> 被触发(' + reason + ')，进入WAIT ' + cfg.SCORING.wait_cooldown + 's 截止' + fmtDate(Math.floor(state.waitUntil / 1000)));
    }

    /** 真正评分一次；返回 null 表示没有可执行结果 */
    private static async judgeMessage(
        ctx: seal.MsgContext, msg: seal.Message, session: Session, messageText: string,
        cfg: JudgeDecisionConfigV2, source: JudgeSource, addressed: boolean, generation: number,
    ): Promise<void> {
        const sid = session.sessionId;
        const state = this.ensureState(sid);
        const outcome = await this.judgeOnce(ctx, session, messageText, cfg, addressed);
        if (generation !== this.generationOf(sid)) {
            log.info('判定结果丢弃：会话判定代际已变化（src=' + source + '）');
            return;
        }
        const decision = outcome.decision;
        state.lastDecision = {
            at: Date.now(),
            action: decision.action,
            S: decision.S,
            U: decision.U,
            reason: outcome.reason || decision.reason,
            source,
            backend: outcome.backend,
        };
        const round = (value: number): number => Math.round(value * 100) / 100;
        // dims = 最终参与 S 的 0~10 六维（模型分 + 规则 max/回退）；features = 零 LLM 规则特征（0~1）。
        const dimsText = JSON.stringify({
            addressed: round(outcome.dims.addressed),
            help: round(outcome.dims.help_signal),
            relevance: round(outcome.dims.relevance),
            friendships: round(outcome.dims.friendships),
            silence: round(outcome.dims.silence_gap),
            risk: round(outcome.dims.interruption_risk),
        });
        const featuresText = JSON.stringify({
            addressed: round(outcome.features.addressed),
            help: round(outcome.features.help_signal),
            relevance: round(outcome.features.relevance),
            friendships: round(outcome.features.friendships),
            silence: round(outcome.features.silence_gap),
            risk: round(outcome.features.interruption_risk),
        });
        log.info(
            '[judge-decision] sid=' + sid + ' src=' + source + ' S=' + decision.S.toFixed(3) + ' U=' + decision.U.toFixed(2)
            + ' action=' + decision.action + ' backend=' + outcome.backend + ' reason="' + String(outcome.reason).slice(0, 120) + '"'
            + ' dims=' + dimsText + ' features=' + featuresText
            + ' history=' + outcome.historyCount + '/' + outcome.historyTokens + 'tok costMs=' + outcome.costMs
            + (outcome.missingModel ? ' model=missing' : ''),
        );
        await this.applyDecision(decision, ctx, msg, session, source, generation);
    }

    /** 一次评分：上下文/特征 → prompt 或 System One → 解析 → merge → decide */
    private static async judgeOnce(
        ctx: seal.MsgContext, session: Session, messageText: string,
        cfg: JudgeDecisionConfigV2, addressed: boolean,
    ): Promise<JudgeOnceOutcome> {
        const startedAt = Date.now();
        const botName = seal.formatTmpl(ctx, "核心:骰子名字") || '骰娘';
        const { roleSetting } = getRoleSetting(ctx);
        const projected = this.projectJudgeContext(session, ctx.endPoint.userId, messageText, startedAt, addressed);
        const features = extractFeatures({
            messages: projected.featureMessages,
            msgTimes: projected.msgTimes,
            senderIds: projected.senderIds,
            botId: ctx.endPoint.userId,
            isGroup: !ctx.isPrivate,
            now: startedAt,
            candidate: projected.candidate,
            roleSetting,
        });

        let missingModel = false;
        try {
            const hasModel = getAuxLlm().hasModel;
            if (hasModel) missingModel = !(await hasModel('judge_agent'));
        } catch (_e) {
            missingModel = false;
        }

        let backend: 'chat' | 'decision' = 'chat';
        if (!missingModel) {
            try {
                const kind = getAuxLlm().modelKind;
                if (kind) backend = await kind('judge_agent');
            } catch (_e) {
                backend = 'chat';
            }
        }

        const input: BuildJudgePromptInput = {
            botName,
            botId: ctx.endPoint.userId,
            roleSetting,
            history: projected.history,
            candidate: projected.candidate,
            features,
            contextTokens: cfg.MODEL.context_tokens,
            promptExtra: cfg.PROMPT.extra,
            now: startedAt,
        };
        const built = !missingModel && backend === 'chat' ? buildJudgeMessages(input) : null;
        const payload = !missingModel && backend === 'decision' ? buildSystemOnePayload(input) : null;

        let raw = '';
        let systemOneData: unknown = null;
        let lastError = '';
        if (!missingModel) {
            for (let attempt = 0; attempt <= cfg.MODEL.retries; attempt++) {
                try {
                    if (backend === 'decision') {
                        const systemOne = getAuxLlm().systemOne;
                        if (!systemOne) throw new Error('System One 决策调用未实现');
                        systemOneData = await withTimeout(
                            () => systemOne('judge_agent', payload!.state, payload!.questions),
                            cfg.MODEL.timeout_sec * 1000,
                        );
                    } else {
                        raw = await withTimeout(
                            () => getAuxLlm().chatMessages('judge_agent', built!.messages),
                            cfg.MODEL.timeout_sec * 1000,
                        );
                    }
                    break;
                } catch (e) {
                    lastError = e instanceof Error ? e.message : String(e);
                    raw = '';
                    systemOneData = null;
                }
            }
        }

        let llmDims: Partial<JudgeFeatureDims> | null = null;
        let parseError = '';
        if (!missingModel) {
            if (backend === 'decision') {
                llmDims = systemOneData ? parseSystemOneAnswers(systemOneData) : null;
                if (!llmDims) parseError = 'system one response invalid';
            } else {
                const parsed = raw ? parseScores(raw) : null;
                if (parsed) {
                    if (parsed.ok) llmDims = parsed.value.dims;
                    else parseError = (parsed as { error: string }).error;
                }
            }
        }
        const failed = !missingModel && !llmDims;
        const dims = mergeDims(features, llmDims);
        const decision = decide({
            dims,
            failed: missingModel || failed,
            weights: cfg.WEIGHTS,
            policy: {
                aggressiveness: cfg.DECISION.aggressiveness,
                speak_threshold: cfg.SCORING.speak_threshold,
            },
        });
        const reason = missingModel
            ? 'model:missing'
            : (failed ? (parseError || lastError || 'judge model failed') : decision.reason);
        return {
            decision,
            features,
            dims,
            reason,
            backend,
            failed,
            missingModel,
            historyCount: built?.historyCount ?? payload?.historyCount ?? 0,
            historyTokens: built?.historyTokens ?? payload?.historyTokens ?? 0,
            costMs: Date.now() - startedAt,
        };
    }

    /** 执行动作：SPEAK → 起轮；WAIT → 进入 30s WAIT */
    private static async applyDecision(
        decision: DecideResult, ctx: seal.MsgContext, msg: seal.Message, session: Session,
        source: JudgeSource, generation: number,
    ): Promise<void> {
        if (this.generationOf(session.sessionId) !== generation) {
            log.info('判定结果丢弃：会话判定代际已变化（src=' + source + '）');
            return;
        }
        if (!this.aiEnabled(session)) {
            log.info('判定结果丢弃：AI 已关闭（src=' + source + '）');
            return;
        }
        const stopFired = (session as unknown as { stopEvent?: { fired?: boolean } }).stopEvent?.fired === true;
        if (stopFired) {
            log.info('判定结果丢弃：会话已被 .ai stop 暂停（src=' + source + '）');
            return;
        }
        if (decision.action === 'SPEAK') {
            // 判定 SPEAK 可能发生在消息到达很久之后，且本轮无新增事件 ⇒ 先写 `[wake]` marker（本轮的"现在"）
            await writeWakeMarker(session, 'judge');
            const outcome = await session.chat(ctx, msg, '评分触发');
            if (outcome !== 'fired') {
                log.info('SPEAK 未真正起轮（' + outcome + '）');
                return;
            }
            log.info('SPEAK 已起轮');
            return;
        }
        this.startWaitRound(ctx, session, '判定WAIT');
    }

    /** 会话判定状态快照（.ai status 观测用；无状态返回 null） */
    static getSessionStats(sid: string): {
        waitUntil: number;
        pending: boolean;
        lastDecision?: JudgeLastDecision;
    } | null {
        const state = this.states.get(sid);
        if (!state) return null;
        return {
            waitUntil: state.waitUntil,
            pending: !!state.pending,
            lastDecision: state.lastDecision,
        };
    }

    /** 会话上下文 → 判定投影：prompt 历史（不含当前候选）+ 独立候选 + 特征消息序列 */
    private static projectJudgeContext(
        session: Session, botId: string, messageText: string, now: number, addressed: boolean,
    ): {
        history: JudgeContextMessage[];
        candidate: JudgeContextMessage;
        featureMessages: JudgeContextMessage[];
        msgTimes: number[];
        senderIds: (string | undefined)[];
    } {
        const rawMessages = session.context.messages as any[];
        const history: JudgeContextMessage[] = [];
        for (const message of rawMessages) {
            if (!message || typeof message !== 'object') continue;
            const role = String(message.role || 'user');
            if (role !== 'user' && role !== 'assistant') continue;
            const items = Array.isArray(message.contentItems) && message.contentItems.length > 0
                ? message.contentItems
                : [null];
            for (const item of items) {
                const source = item && typeof item.text === 'string' ? item.text : buildContent(message);
                const text = String(source || '').split(String.fromCharCode(12)).join(String.fromCharCode(10)).trim();
                if (!text) continue;
                const timeSec = item && typeof item.time === 'number' && item.time > 0 ? item.time : undefined;
                const itemUserId = item && typeof item.userId === 'string' ? item.userId : undefined;
                history.push({
                    role,
                    text,
                    time: timeSec ? timeSec * 1000 : undefined,
                    userId: itemUserId,
                    mentionsBot: role === 'user' ? this.mentionsIdInText(text, botId) : undefined,
                    mentionsOthers: role === 'user' ? this.mentionsOtherInText(text, botId) : undefined,
                });
            }
        }
        const rawCurrent = String(messageText || '').split(String.fromCharCode(12)).join(String.fromCharCode(10)).trim();
        const currentText = truncateMiddleToTokenBudget(rawCurrent, CANDIDATE_MAX_TOKENS, estimateTextTokens).text;
        while (history.length > 0) {
            const last = history[history.length - 1];
            if (last.role !== 'user') break;
            if (last.text === rawCurrent || (rawCurrent !== '' && last.text.includes(rawCurrent))) {
                history.pop();
                break;
            }
            break;
        }
        const candidate: JudgeContextMessage = {
            role: 'user',
            text: currentText,
            time: now,
            mentionsBot: addressed,
            mentionsOthers: this.mentionsOtherInText(currentText, botId),
        };
        const state = this.ensureState(session.sessionId);
        const timeline = state.timeline;
        const msgTimes = timeline.length > 0 ? timeline.map(item => item.time) : history
            .filter(item => typeof item.time === 'number')
            .map(item => item.time as number);
        const senderIds = timeline.length > 0 ? timeline.map(item => item.senderId) : [];
        return {
            history,
            candidate,
            featureMessages: [...history, candidate],
            msgTimes,
            senderIds,
        };
    }

    /** 文本里是否 @/引用了指定 id */
    private static mentionsIdInText(text: string, id: string): boolean {
        const target = String(id || '').replace(/\D/g, '');
        if (!target) return false;
        const regex = /\[(?:CQ:at,qq=|at:)([^\]]+)\]/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            if (String(match[1] || '').replace(/\D/g, '') === target) return true;
        }
        return false;
    }

    /** 文本里是否 @ 了别人 */
    private static mentionsOtherInText(text: string, botId: string): boolean {
        const target = String(botId || '').replace(/\D/g, '');
        const regex = /\[(?:CQ:at,qq=|at:)([^\]]+)\]/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const value = String(match[1] || '').replace(/\D/g, '');
            if (value && value !== 'all' && value !== target) return true;
        }
        return false;
    }
}

// 把 WAIT 到点收尾注册到 L0 端口
setJudgeWaitFinisher((sid) => JudgeManager.endWaitRound(sid));
