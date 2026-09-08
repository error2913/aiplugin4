// 子代理运行时接线（对接层）：ext 存储 KV + spawn/fork executor + notice 投递 + 唤醒决策 + jobs 单例。
// 工具层调用 getSubAgentService()/getSubAgentJobs()；本文件引入运行时模块，不参与机制层纯单测。
import Config, { ext } from '../../config/config';
import Logger from '../../logger';
import type { Session } from '../../session/session';
import { getSession } from '../../session/session_service';
import { getSessionCtxAndMsg } from '../../utils/seal';
import { fireStopEvent } from '../../utils/utils';

import { buildForkSeed, createChildSession, decodeCheckpoint, encodeCheckpoint, runHeadlessActivation } from './child';
import type { CheckpointMessage } from './child';
import { buildChildSystemContent } from './child_system';
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
    '你是一名子代理。请独立完成交付的任务：分步推进、需要信息时自行调用可用工具，'
    + '不确定时明确说明而不编造；完成后给出最终结论。';

export interface RuntimeRef {
    ctx: seal.MsgContext;
    msg: seal.Message;
    parentSession: Session;
}

export interface SubAgentWireOptions {
    defaultInstruction?: string;
    maxTurns?: number;
    budgetMs?: number;
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
            const v = ext.storageGet(key);
            return v === null || v === '' ? null : v;
        },
        set: (key, value) => ext.storageSet(key, value),
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
            const seed = fork ? buildForkSeed(rt.parentSession.context.messages) : undefined;
            const result: SubAgentResult = await runHeadlessActivation({
                ctx: rt.ctx,
                msg: rt.msg,
                child,
                systemText,
                task: req.prompt,
                use: 'chat',
                maxTurns: opt.maxTurns,
                budgetMs: opt.budgetMs,
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
        const raw = ext.storageGet(`session_${parentSessionId}`);
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
    const seed = isFork ? buildForkSeed(ref.parentSession.context.messages) : undefined;
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
