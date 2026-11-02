// 记忆调度器：持久化队列 + 门控（无 AI 不跑、在线让路、熔断）+ 重载恢复。
import Config from "../config/config";
import { getHost } from "../core/host";
import { MemoryService, setMentalModelSeedHook } from "../memory/service";
import { classifyAuxError, isClassifiedApiError } from "../model/api_error";
import { isAuxPaused, noteFatalAuxError, trySwitchSummarizationModel } from "../model/aux_breaker";
import type { Session } from "../session/session";
import { requestLimiter } from "../utils/concurrency";

export type JobKind = 'consolidate' | 'mm_refresh' | 'mm_full';
export type JobSource = 'ai' | 'archive' | 'manual' | 'seed';
export type JobState = 'queued' | 'running' | 'backoff' | 'dead' | 'degraded';

export interface MemoryJob {
    id: string;
    kind: JobKind;
    bankId: string;
    sessionId?: string;
    modelId?: string;
    source: JobSource;
    priority: 0 | 1 | 2 | 3;
    state: JobState;
    notBefore: number;
    attempts: number;
    payload?: { scopeTags?: string[]; deferSince?: number; force?: boolean; pages?: number };
    createdAt: number;
}

interface SchedulerState {
    version: 1;
    jobs: MemoryJob[];
    running: string | null;
    lastTickAt: number;
    lastAiActivityAt: number;
    failureStreak: number;
    pausedUntil: number;
}

const STORAGE_KEY = 'mem_sched_v1';
const QUEUE_LIMIT = 200;
const AI_GRACE_SEC = 30 * 60;
const MAX_ATTEMPTS = 3;
const BREAKER_SEC = 30 * 60;
const DEFER_MS = 5000;
const MAX_DEFER_MS = 10 * 60 * 1000;

let state: SchedulerState = emptyState();
let timer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let activeAiRuns = 0;

function emptyState(): SchedulerState {
    return {
        version: 1,
        jobs: [],
        running: null,
        lastTickAt: 0,
        lastAiActivityAt: 0,
        failureStreak: 0,
        pausedUntil: 0,
    };
}

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function load(): void {
    try {
        const raw = getHost().storage.get(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Partial<SchedulerState>;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return;
        // 显式字段重建：丢弃旧版本遗留字段（如 hourly），并过滤已下线的 extract job
        state = {
            ...emptyState(),
            jobs: parsed.jobs
                .filter(Boolean)
                .filter(j => (j as { kind: string }).kind !== 'extract')
                .map(j => ({ ...j, state: j.state === 'running' ? 'queued' : j.state })),
            running: null,
            lastAiActivityAt: 0,
            lastTickAt: Number(parsed.lastTickAt) || 0,
            failureStreak: Number(parsed.failureStreak) || 0,
            pausedUntil: Number(parsed.pausedUntil) || 0,
        } as SchedulerState;
    } catch {
        state = emptyState();
    }
}

function save(): void {
    try { getHost().storage.set(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function keyOf(job: Pick<MemoryJob, 'kind' | 'bankId' | 'modelId'>): string {
    return `${job.kind}:${job.bankId}:${job.modelId || ''}`;
}

function enqueue(job: Omit<MemoryJob, 'id' | 'state' | 'notBefore' | 'attempts' | 'createdAt'> & Partial<Pick<MemoryJob, 'notBefore' | 'attempts'>>): void {
    const key = keyOf(job);
    const existing = state.jobs.find(j => keyOf(j) === key && (j.state === 'queued' || j.state === 'backoff' || j.state === 'running'));
    if (existing) {
        // 合并：保留更晚的退避时间；manual 请求提升优先级并解除 AI 门控
        existing.notBefore = Math.max(existing.notBefore || 0, job.notBefore ?? 0);
        if (job.source === 'manual') {
            existing.source = 'manual';
            existing.priority = 0;
            existing.notBefore = 0;
        }
        if (job.payload?.force) existing.payload = { ...existing.payload, force: true };
        save();
        ensureRunning();
        return;
    }
    if (state.jobs.length >= QUEUE_LIMIT) {
        const victim = state.jobs
            .filter(j => j.priority >= 2 && j.state !== 'running')
            .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
        if (!victim) return;
        state.jobs = state.jobs.filter(j => j !== victim);
    }
    const created: MemoryJob = {
        id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind: job.kind,
        bankId: job.bankId,
        sessionId: job.sessionId,
        modelId: job.modelId,
        source: job.source,
        priority: job.priority,
        state: 'queued',
        notBefore: job.notBefore ?? 0,
        attempts: job.attempts ?? 0,
        payload: job.payload || {},
        createdAt: nowSec(),
    };
    state.jobs.push(created);
    save();
    ensureRunning();
}

function ensureRunning(): void {
    if (timer || state.running) return;
    timer = setTimeout(() => {
        timer = null;
        void MemoryScheduler.tick();
    }, 1000);
}

function stopTimer(): void {
    if (timer) { clearTimeout(timer); timer = null; }
}

function runnable(now: number): MemoryJob[] {
    return state.jobs
        .filter(j => j.state === 'queued' || j.state === 'backoff')
        .filter(j => (j.notBefore || 0) <= now)
        .filter(j => {
            if (j.source === 'manual') return true;
            if (state.lastAiActivityAt <= 0) return false;
            return now - state.lastAiActivityAt <= AI_GRACE_SEC;
        })
        .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

function chatBusy(): boolean {
    const info = requestLimiter.getQueueInfo();
    return info.active > 0 || info.queued > 0;
}

/** aux 模型未配置（Agent.chat 抛的固定错误）：不值得重试，标记 degraded 丢弃。 */
function isAuxUnavailable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message === 'aux_llm_unavailable';
}

export class MemoryScheduler {
    static init(): void {
        if (initialized) return;
        initialized = true;
        load();
        setMentalModelSeedHook((bankId, modelIds) => {
            for (const modelId of modelIds) {
                enqueue({ kind: 'mm_refresh', bankId, modelId, source: 'seed', priority: 2, payload: { force: false } });
            }
        });
        if (state.jobs.length) ensureRunning();
    }

    /** 主 AI 轮开始：自动任务在轮内让路（避免提示词构建期间并发 LLM）。 */
    static onRunStart(session: Session): void {
        if (!session || session.headless || (session as any).subagentDepth > 0) return;
        activeAiRuns++;
    }

    /** run 结束：只 enqueue，不 await LLM。 */
    static onRunEnd(session: Session): void {
        if (!session || session.headless || (session as any).subagentDepth > 0) return;
        activeAiRuns = Math.max(0, activeAiRuns - 1);
        try {
            state.lastAiActivityAt = nowSec();
            save();
            if (!configBool('MEMORY_ENABLED', true)) return;
            const bankId = MemoryService.bankIdForSessionId(session.sessionId, session.agentName);
            // 兜底 reconcile：上次巩固未完成/进程中断时，下一次 AI 触发继续。
            // 抽取已并入归档（context/compact），这里不再入队 extract。
            if (MemoryService.pendingCount(bankId) > 0) {
                enqueue({ kind: 'consolidate', bankId, source: 'ai', priority: 2 });
            }
        } catch { /* ignore */ }
    }

    /** 归档 facts 写库后调用：把触及的 bank 排入巩固队列（跨 bank 也覆盖）。 */
    static enqueueConsolidate(bankId: string, source: JobSource = 'archive', priority: 0 | 1 | 2 | 3 = 2): void {
        if (!bankId) return;
        enqueue({ kind: 'consolidate', bankId, source, priority });
    }

    /** 外部（归档 sink）触发调度循环：不等待执行。 */
    static wake(): void {
        ensureRunning();
    }

    /** 手动命令/工具：入队并立刻尝试（不等待）。 */
    static poke(): void { ensureRunning(); }

    static dropSession(sessionId: string): void {
        state.jobs = state.jobs.filter(j => j.sessionId !== sessionId);
        save();
    }

    static dropBank(bankId: string): void {
        state.jobs = state.jobs.filter(j => j.bankId !== bankId);
        save();
    }

    static status(): { jobs: number; running: string | null; pausedUntil: number; lastAiActivityAt: number } {
        return {
            jobs: state.jobs.length,
            running: state.running,
            pausedUntil: state.pausedUntil,
            lastAiActivityAt: state.lastAiActivityAt,
        };
    }

    static snapshot(): MemoryJob[] {
        return JSON.parse(JSON.stringify(state.jobs)) as MemoryJob[];
    }

    /** 测试专用：直接入队（不经过 AI 门控判断）。 */
    static enqueueForTest(job: Omit<MemoryJob, 'id' | 'state' | 'notBefore' | 'attempts' | 'createdAt'>): void {
        enqueue(job as any);
    }

    /** 手动创建/清空心智模型后触发一次刷新；manual 不受 AI 门控限制。 */
    static enqueueMentalModelRefresh(bankId: string, modelId: string, source: JobSource = 'manual'): void {
        enqueue({
            kind: 'mm_refresh', bankId, modelId, source,
            priority: source === 'manual' ? 0 : 2,
            payload: { force: false },
        });
    }

    /** 可测入口：处理一个可运行 job。 */
    static async tick(now = nowSec()): Promise<boolean> {
        if (state.running) return false;
        if (state.pausedUntil > now) return false;
        // 进程级 aux 熔断（余额/鉴权类错误）期间不发起任何后台 aux 调用
        if (isAuxPaused()) return false;
        const jobs = runnable(now);
        if (!jobs.length) return false;
        const job = jobs[0];
        if (job.source !== 'manual' && activeAiRuns > 0) {
            job.notBefore = now + Math.ceil(DEFER_MS / 1000);
            save();
            ensureRunning();
            return false;
        }
        if (job.priority > 0 && chatBusy()) {
            job.payload.deferSince = job.payload.deferSince || Date.now();
            if (Date.now() - job.payload.deferSince < MAX_DEFER_MS) {
                job.notBefore = now + Math.ceil(DEFER_MS / 1000);
                save();
                ensureRunning();
                return false;
            }
        }
        state.running = job.id;
        job.state = 'running';
        save();
        try {
            await run(job);
            state.jobs = state.jobs.filter(j => j.id !== job.id);
            state.failureStreak = 0;
        } catch (error) {
            // 分类错误优先：fatal 立即熔断（不重试、不累加 attempts）；retry 走退避；
            // 其余（JSON 坏/无模型等）保持原有 degraded/dead 语义。
            if (isClassifiedApiError(error)) {
                const cls = classifyAuxError(error.kind);
                if (cls === 'fatal') {
                    noteFatalAuxError(error.kind, error.message);
                    trySwitchSummarizationModel();
                    state.pausedUntil = Math.max(state.pausedUntil, now + BREAKER_SEC);
                    job.state = 'queued';
                    job.notBefore = now + BREAKER_SEC;
                    save();
                    return false;
                }
                if (cls === 'retry') {
                    job.attempts++;
                    job.state = 'backoff';
                    job.notBefore = now + Math.min(60, Math.pow(2, job.attempts - 1));
                    save();
                    return false;
                }
            }
            const message = error instanceof Error ? error.message : String(error);
            if (isAuxUnavailable(error)) {
                job.state = 'degraded';
                state.jobs = state.jobs.filter(j => j.id !== job.id);
            } else if (/^extract_invalid_json$/i.test(message)) {
                job.state = 'degraded';
                state.jobs = state.jobs.filter(j => j.id !== job.id);
            } else {
                job.attempts++;
                if (job.attempts >= MAX_ATTEMPTS) {
                    job.state = 'dead';
                    state.jobs = state.jobs.filter(j => j.id !== job.id);
                    state.failureStreak++;
                    if (state.failureStreak >= 3) state.pausedUntil = now + BREAKER_SEC;
                } else {
                    job.state = 'backoff';
                    job.notBefore = now + Math.min(60, Math.pow(2, job.attempts - 1));
                }
            }
        } finally {
            state.running = null;
            save();
            if (state.jobs.some(j => j.state === 'queued' || j.state === 'backoff')) ensureRunning();
            else stopTimer();
        }
        return true;
    }
}

async function run(job: MemoryJob): Promise<void> {
    if (!configBool('MEMORY_ENABLED', true)) return;
    if (job.kind === 'consolidate') {
        if (!configBool('OBSERVATION_ENABLED', true)) return;
        const outcome = await MemoryService.consolidateBank(job.bankId);
        if (configBool('MM_REFRESH_AFTER_CONSOLIDATION', false) && outcome.touchedTags.length) {
            enqueue({ kind: 'mm_refresh', bankId: job.bankId, source: 'ai', priority: 3, payload: { scopeTags: outcome.touchedTags } });
        }
        // 有界自续队：一次最多连续 2 页（pages），避免无上限连发
        const pages = job.payload?.pages ?? 0;
        if (outcome.pendingRemaining > 0 && pages < 2) {
            enqueue({
                kind: 'consolidate',
                bankId: job.bankId,
                source: job.source === 'manual' ? 'manual' : 'ai',
                priority: 3,
                notBefore: nowSec() + 30,
                payload: { pages: pages + 1 },
            });
        }
        return;
    }
    if (job.kind === 'mm_refresh' || job.kind === 'mm_full') {
        await MemoryService.refreshMentalModels(job.bankId, {
            id: job.modelId,
            force: job.kind === 'mm_full' || !!job.payload.force,
            reason: job.source === 'seed' ? 'seed' : 'consolidate',
            touchedTags: job.payload.scopeTags,
        });
        return;
    }
}

function configBool(key: string, fallback: boolean): boolean {
    const value = (Config.memory as unknown as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : fallback;
}

// 兼容旧测试/诊断
export function resetMemorySchedulerForTest(): void {
    stopTimer();
    state = emptyState();
    activeAiRuns = 0;
    initialized = false;
    save();
}

export function getMemorySchedulerStateForTest(): SchedulerState {
    return JSON.parse(JSON.stringify(state)) as SchedulerState;
}

