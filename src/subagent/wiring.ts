import Config from '../config/config';
import { getHost } from "../core/host";
import { getAuxLlm, hasAuxLlm } from '../core/ports/aux_llm';
// 子代理运行时接线（对接层）：ext 存储 KV + spawn/fork executor + notice 投递 + 唤醒决策 + jobs 单例。
// 工具层调用 getSubAgentService()/getSubAgentJobs()；本文件引入运行时模块，不参与机制层纯单测。
import Logger from '../logger';
import Model from '../model/model';
import { getProbedContextWindow } from '../model/window_cache';
import type { Session } from '../session/session';
import { getSession } from '../session/session_service';
import { getSessionCtxAndMsg } from '../utils/seal';
import { fireStopEvent } from "../utils/timeout";

import { buildForkSeed, createChildSession, decodeCheckpoint, encodeCheckpoint, runHeadlessActivation } from './child';
import type { CheckpointMessage } from './child';
import { buildChildSystemContent } from './child_system';
import type { SubAgentSummaryFn } from './context';
import { SubAgentJobs } from './jobs';
import { createForkProvider, createSpawnProvider } from './providers';
import type { SubAgentExecutor } from './providers';
import { SubAgentService } from './service';
import { SubAgentStore } from './store';
import type { KvLike } from './store';
import type { ChildRecord, StartRequest, SubAgentResult } from './types';
import { decideWake, WAKE_REASON } from './wake';



const log = Logger.withTag('subagent');

const DEFAULT_CHILD_INSTRUCTION =
    'You are a sub-agent. Independently complete the task you are given: make progress step by step, '
    + 'call available tools yourself when information is needed, state clearly when unsure instead of making things up, '
    + 'and give the final conclusion when done.';

/** 子代理上下文默认上限（token）：配置 0 且模型窗口未探测到时的回退值 */
export const DEFAULT_SUBAGENT_CONTEXT_TOKENS = 32000;
/** 跟随模型窗口时的安全系数（与主链一致：窗口 × 0.8） */
const SUBAGENT_WINDOW_SAFETY = 0.8;

/**
 * 解析子代理上下文上限：「子代理上下文上限」配置 > 0 用它；
 * 否则跟随模型探测窗口 × 0.8；未探测到回退 32000。
 */
export function resolveSubAgentContextTokens(configured: number = Config.subagent.CONTEXT_MAX_TOKENS): number {
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    const modelName = Model.getChatModel('chat')?.name || '';
    const window = getProbedContextWindow(modelName);
    if (window !== undefined && Number.isFinite(window) && window > 0) {
        return Math.max(1, Math.floor(window * SUBAGENT_WINDOW_SAFETY));
    }
    return DEFAULT_SUBAGENT_CONTEXT_TOKENS;
}

/**
 * fork 种子：优先用父上下文编译器按子代理预算取（包含摘要/工具组/最新内容），
 * 未接入事件账本时退回旧投影函数。
 */
function buildContextForkSeed(session: Session, budgetTokens: number): ReturnType<typeof buildForkSeed> {
    const service = session.contextV2;
    if (!service) return buildForkSeed(session.context.messages);
    try {
        const estimateText = (text: string) => Math.max(1, Math.ceil(text.length / 3));
        const compiled = service.compile({
            prefixMessages: [],
            budgetTokens,
            toolsReserveTokens: 0,
            mode: 'native',
            caps: { vision: false },
            estimateTextTokens: estimateText,
            estimateEventTokens: (event) => {
                const parts = (event as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
                let chars = 0;
                for (const part of parts) if (part.type === 'text') chars += String(part.text ?? '').length;
                if (event.kind === 'tool_call') chars += String(event.args ?? '').length;
                return Math.max(1, Math.ceil(chars / 3)) + 4;
            },
        });
        return compiled.messages as unknown as ReturnType<typeof buildForkSeed>;
    } catch {
        return buildForkSeed(session.context.messages);
    }
}

/**
 * 子代理摘要器：走 aux LLM（summarize_agent），用于超上限时压缩更早上下文。
 * aux LLM 未初始化时返回 undefined → 上下文层走确定性降级（保留最近内容 + 省略标记）。
 */
export function createSubAgentSummarizer(): SubAgentSummaryFn | undefined {
    if (!hasAuxLlm()) return undefined;
    return async (input: string, opts: { maxTokens: number }) => {
        const prompt = [
            `Compress the following sub-agent conversation history into one concise summary (no more than ${opts.maxTokens} tokens).`,
            'You must keep: the task goal, key facts and numbers, completed actions/tool calls and their conclusions, unfinished items and constraints.',
            'Do not make things up, do not output greetings, output only the summary body.',
            'Write all generated text in the language of the conversation.',
            '',
            input,
        ].join('\n');
        return getAuxLlm().chat('summarize_agent', prompt);
    };
}

export interface RuntimeRef {
    ctx: seal.MsgContext;
    msg: seal.Message;
    parentSession: Session;
}

export interface SubAgentWireOptions {
    defaultInstruction?: string;
    maxTurns?: number;
    budgetMs?: number;
    /** 子代理上下文 token 上限覆盖（缺省=配置「子代理上下文上限」，0 时跟随模型窗口×0.8） */
    maxContextTokens?: number;
    /** 后台 child 终态后是否允许唤醒父会话（总闸，默认开；受 decideWake 条件约束） */
    enableWake?: boolean;
}

let service: SubAgentService | null = null;
let jobs: SubAgentJobs | null = null;
let subStore: SubAgentStore | null = null;
let wireOptions: SubAgentWireOptions = {};

function extKv(): KvLike {
    return {
        get: key => {
            const v = getHost().storage.get(key);
            return v === null || v === '' ? null : v;
        },
        set: (key, value) => getHost().storage.set(key, value),
    };
}

function runtimeOf(req: StartRequest): RuntimeRef {
    const rt = req.runtime as RuntimeRef | undefined;
    if (!rt || !rt.ctx || !rt.msg || !rt.parentSession) {
        throw new Error('subagent executor 需要运行时现场（ctx/msg/parentSession）');
    }
    return rt;
}

function makeExecutor(fork: boolean, opt: SubAgentWireOptions): SubAgentExecutor {
    const defaultInstruction = opt.defaultInstruction ?? DEFAULT_CHILD_INSTRUCTION;
    return {
        async start(req: StartRequest) {
            const rt = runtimeOf(req);
            const instruction = req.persona && req.persona !== '' ? req.persona : defaultInstruction;
            const systemText = buildChildSystemContent({ instruction });
            const child = createChildSession({
                sessionId: req.childSessionId ?? '',
                parentSessionId: req.parent.sessionId,
                isPrivate: req.parent.isPrivate,
                depth: req.parent.depth + 1,
                agentName: req.persona ?? '',
                toolStateSnapshot: rt.parentSession.toolState,
                toolFilter: req.toolFilter ?? null,
            });
            const maxContextTokens = opt.maxContextTokens ?? resolveSubAgentContextTokens();
            const seed = fork ? buildContextForkSeed(rt.parentSession, maxContextTokens) : undefined;
            const result: SubAgentResult = await runHeadlessActivation({
                ctx: rt.ctx,
                msg: rt.msg,
                child,
                systemText,
                task: req.prompt,
                use: 'chat',
                maxTurns: opt.maxTurns,
                budgetMs: opt.budgetMs,
                maxContextTokens,
                summarize: createSubAgentSummarizer(),
                ...(seed && seed.length > 0 ? { seed } : {}),
            });
            return {
                id: req.childSessionId ?? req.childId ?? 'run',
                result: Promise.resolve(result),
                dispose: async () => { /* 无资源需要释放 */ },
            };
        },
        async prepareContinuable() {
            return {}; // 激活时按需重建（runContinuableActivation）
        },
    };
}

/** notice 落点：push 进父会话 noticeQueue（childId 用于生命周期绑定标记；主链每轮 flushNotices 呈现） */
function noticeSink(parentSessionId: string, text: string, childId?: string): void {
    try {
        const parent = getSession(parentSessionId);
        parent.noticeQueue.push({ text, from: childId ?? '', time: Date.now() });
    } catch (e) {
        log.warning(`notice 入队失败: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** 父上下文（落盘 JSON）中现存子代理 notice 引用的 childId 集合：生命周期清扫判定 */
function contextNoticeChildIds(parentSessionId: string): Set<string> {
    const ids = new Set<string>();
    try {
        const raw = getHost().storage.get(`session_${parentSessionId}`);
        if (raw === null || raw === '') return ids;
        const data = JSON.parse(raw);
        const messages = Array.isArray(data?.context?.messages) ? data.context.messages
            : Array.isArray(data?.messages) ? data.messages : [];
        const visit = (item: unknown) => {
            const rawItem = (item as { raw?: { kind?: string; childId?: string } } | null)?.raw;
            if (rawItem && rawItem.kind === 'subagent-notice' && typeof rawItem.childId === 'string' && rawItem.childId !== '') {
                ids.add(rawItem.childId);
            }
        };
        for (const msg of messages) {
            const m = msg as { contentItems?: unknown[]; raw?: unknown };
            if (Array.isArray(m.contentItems)) for (const it of m.contentItems) visit(it);
            else visit(m);
        }
    } catch {
        // 读取/解析失败按“无 notice”处理（下次触达再收敛）
    }
    return ids;
}

/** settle 后唤醒：父空闲且未待机时，合成 ctx/msg 起一轮（reason=WAKE_REASON）；桶空/忙则自然等待 */
function makeWakeHook(opt: SubAgentWireOptions): (record: ChildRecord, _result: SubAgentResult) => void {
    return (record) => {
        if (opt.enableWake === false) return;
        try {
            const parent = getSession(record.parentSessionId);
            const decision = decideWake({
                noticeCount: parent.noticeQueue.length,
                parentBusy: parent.running || parent.starting,
                sessionStandby: parent.setting.standby === true,
                globalStandby: Config.base.GLOBAL_STANDBY === true,
            });
            if (decision !== 'wake') return;
            const { ctx, msg } = getSessionCtxAndMsg(record.meta.epId, record.parentSessionId, record.meta.isPrivate);
            void parent.chat(ctx, msg, WAKE_REASON).catch(e => {
                log.warning(`子代理完成唤醒失败: ${e instanceof Error ? e.message : String(e)}`);
            });
        } catch (e) {
            log.warning(`子代理完成唤醒跳过: ${e instanceof Error ? e.message : String(e)}`);
        }
    };
}

/** 初始化（幂等）：ext KV 存储 + spawn/fork provider + notice/唤醒/生命周期清扫接线 + 服务单例 */
export function initSubAgentService(opt: SubAgentWireOptions = {}): SubAgentService {
    wireOptions = { ...wireOptions, ...opt };
    if (service) return service;
    subStore = new SubAgentStore(extKv());
    const svc = new SubAgentService(
        subStore,
        noticeSink,
        {
            onSettled: makeWakeHook(wireOptions),
            onParentNoticeIds: contextNoticeChildIds,
        }
    );
    svc.registerProvider(createSpawnProvider('spawn', makeExecutor(false, wireOptions)));
    svc.registerProvider(createForkProvider('fork', makeExecutor(true, wireOptions)));
    service = svc;
    // 重载后触发清扫：running 残留对账为 interrupted（可续），孤儿（notice 已不在父上下文）收敛
    for (const root of subStore.listRoots()) {
        try {
            svc.reconcileReload(root);
            svc.sweepParent(root);
        } catch (e) {
            log.warning(`子代理重载清扫失败(${root}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return svc;
}

/** 生命周期清扫（对某父会话）：notice 已被父上下文淘汰的已终态记录 → 清理；运行中不打断 */
export function sweepSubagentParent(parentSessionId: string): number {
    return currentService().sweepParent(parentSessionId);
}

// —— checkpoint（子代理上下文落盘，重载后手动续跑用） ——
export function writeSubagentCheckpoint(childId: string, parentSessionId: string, messages: Parameters<typeof encodeCheckpoint>[0]): void {
    if (!subStore) return;
    subStore.saveChildSession(parentSessionId, childId, { version: 1, at: Date.now(), messages: encodeCheckpoint(messages) });
}

export function readSubagentCheckpoint(childId: string, parentSessionId: string): ReturnType<typeof decodeCheckpoint> | null {
    if (!subStore) return null;
    const payload = subStore.loadChildSession<{ messages?: CheckpointMessage[] }>(parentSessionId, childId);
    if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) return null;
    return decodeCheckpoint(payload.messages);
}

/** one-shot 后台 job 注册表单例 */
export function getSubAgentJobs(): SubAgentJobs {
    if (!jobs) jobs = new SubAgentJobs({ prefix: 'subagent-job', retention: 100 });
    return jobs;
}

/** continuable 激活的运行现场（续跑/唤醒时的调用方现场） */
export interface ContinuableRunRef {
    ctx: seal.MsgContext;
    msg: seal.Message;
    parentSession: Session;
}

function currentService(): SubAgentService {
    if (!service) throw new Error('subagent service 未初始化：先调用 initSubAgentService()');
    return service;
}

/** 由记录重建 child 会话（persona/toolFilter 持久化自记录） */
function childSessionFromRecord(rec: ChildRecord, ref: ContinuableRunRef) {
    return createChildSession({
        sessionId: rec.childSessionId,
        parentSessionId: rec.parentSessionId,
        isPrivate: rec.meta.isPrivate,
        depth: rec.depth,
        agentName: rec.agentName,
        toolStateSnapshot: ref.parentSession.toolState,
        toolFilter: rec.toolFilter ?? null,
    });
}

/**
 * 运行一个 continuable child 的一次激活：markRunning（挂 interrupt 回调）→
 * runHeadlessActivation → finishActivation（终态结算 notice / aborted 回 idle）。
 * 供工具层在 continuable 启动与 send_message 唤醒 idle child 时调用。
 */
export async function runContinuableActivation(childId: string, task: string, ref: ContinuableRunRef): Promise<SubAgentResult | null> {
    const svc = currentService();
    const rec = svc.getRecord(childId);
    if (!rec) return null;
    // 续跑：有 checkpoint（中断/上次激活）则原样回放全部消息，仅追加本轮新任务；否则全新装配
    const base = readSubagentCheckpoint(childId, rec.parentSessionId);
    const child = childSessionFromRecord(rec, ref);
    const systemText = buildChildSystemContent({
        instruction: rec.agentName && rec.agentName !== '' ? rec.agentName : DEFAULT_CHILD_INSTRUCTION,
    });
    const isFork = !base && rec.provider === 'fork';
    const maxContextTokens = wireOptions.maxContextTokens ?? resolveSubAgentContextTokens();
    const seed = isFork ? buildContextForkSeed(ref.parentSession, maxContextTokens) : undefined;
    svc.markRunning(childId, () => fireStopEvent(child.stopEvent));
    try {
        const result = await runHeadlessActivation({
            ctx: ref.ctx,
            msg: ref.msg,
            child,
            systemText,
            task,
            use: 'chat',
            maxTurns: wireOptions.maxTurns,
            budgetMs: wireOptions.budgetMs,
            maxContextTokens,
            summarize: createSubAgentSummarizer(),
            ...(seed && seed.length > 0 ? { seed } : {}),
            ...(base ? { baseMessages: base } : {}),
            checkpoint: msgs => writeSubagentCheckpoint(childId, rec.parentSessionId, msgs),
        });
        svc.finishActivation(childId, result);
        return result;
    } catch (e) {
        const result: SubAgentResult = {
            stopReason: 'error',
            output: '',
            diagnostic: e instanceof Error ? e.message : String(e),
        };
        svc.finishActivation(childId, result);
        return result;
    }
}

/** 测试/热重载用：重置单例 */
export function resetSubAgentServiceForTest(): void {
    service = null;
    jobs = null;
    subStore = null;
    wireOptions = {};
}
