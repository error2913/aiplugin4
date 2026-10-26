// 记忆调度器：持久化队列 + 门控（无 AI 不跑、在线让路、预算/熔断）+ 重载恢复。
import Config from "../config/config";
import { getHost } from "../core/host";
import { getSessionById } from "../core/ports/session_lookup";
import { MemoryService, setMentalModelSeedHook } from "../memory/service";
import type { Session } from "../session/session";
import { requestLimiter } from "../utils/concurrency";

import { collectContextBacklog, commitExtraction, peekExtractionChunk } from "./context_bridge";

export type JobKind = 'extract' | 'consolidate' | 'mm_refresh' | 'mm_full';
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
    payload?: { throughSeq?: number; textLength?: number; scopeTags?: string[]; deferSince?: number; force?: boolean };
    createdAt: number;
}

interface SchedulerState {
    version: 1;
    jobs: MemoryJob[];
    running: string | null;
    lastTickAt: number;
    lastAiActivityAt: number;
    hourly: { windowStart: number; llmCalls: number };
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
        hourly: { windowStart: 0, llmCalls: 0 },
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
        state = {
            ...emptyState(),
            ...parsed,
            jobs: parsed.jobs.filter(Boolean).map(j => ({ ...j, state: j.state === 'running' ? 'queued' : j.state })),
            running: null,
            lastAiActivityAt: 0,
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

function takeBudget(): boolean {
    const now = nowSec();
    if (!state.hourly.windowStart || now - state.hourly.windowStart >= 3600) {
        state.hourly = { windowStart: now, llmCalls: 0 };
    }
    if (state.hourly.llmCalls >= hourlyLimit()) return false;
    state.hourly.llmCalls++;
    save();
    return true;
}

function chatBusy(): boolean {
    const info = requestLimiter.getQueueInfo();
    return info.active > 0 || info.queued > 0;
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
            collectContextBacklog(session);
            state.lastAiActivityAt = nowSec();
            save();
            if (!configBool('MEMORY_ENABLED', true)) return;
            if (!configBool('EXTRACT_ENABLED', true)) return;
            const bankId = MemoryService.bankIdForSessionId(session.sessionId, session.agentName);
            const chunk = peekExtractionChunk(session);
            if (chunk) {
                enqueue({
                    kind: 'extract',
                    bankId,
                    sessionId: session.sessionId,
                    source: 'ai',
                    priority: 1,
                    payload: { throughSeq: chunk.throughSeq, textLength: chunk.textLength },
                });
            }
            // 兜底 reconcile：上次巩固未完成/进程中断时，下一次 AI 触发继续
            if (MemoryService.pendingCount(bankId) > 0) {
                enqueue({ kind: 'consolidate', bankId, source: 'ai', priority: 2 });
            }
        } catch { /* ignore */ }
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

    static status(): { jobs: number; running: string | null; hourlyCalls: number; pausedUntil: number; lastAiActivityAt: number } {
        return {
            jobs: state.jobs.length,
            running: state.running,
            hourlyCalls: state.hourly.llmCalls,
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
        if (job.priority > 0 && !takeBudget()) {
            job.notBefore = now + 60;
            save();
            ensureRunning();
            return false;
        }
        state.running = job.id;
        job.state = 'running';
        save();
        try {
            await run(job);
            state.jobs = state.jobs.filter(j => j.id !== job.id);
            state.failureStreak = 0;
        } catch (error) {
            job.attempts++;
            const message = error instanceof Error ? error.message : String(error);
            if (/json|parse|invalid|no facts/i.test(message)) {
                job.state = 'degraded';
                state.jobs = state.jobs.filter(j => j.id !== job.id);
            } else if (job.attempts >= MAX_ATTEMPTS) {
                job.state = 'dead';
                state.jobs = state.jobs.filter(j => j.id !== job.id);
                state.failureStreak++;
                if (state.failureStreak >= 3) state.pausedUntil = now + BREAKER_SEC;
            } else {
                job.state = 'backoff';
                job.notBefore = now + Math.min(60, Math.pow(2, job.attempts - 1));
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
    if (job.kind === 'extract') {
        if (!configBool('EXTRACT_ENABLED', true)) return;
        const session = job.sessionId ? getSessionById(job.sessionId) : null;
        if (!session) return;
        for (let i = 0; i < 2; i++) {
            const chunk = peekExtractionChunk(session);
            if (!chunk) break;
            const outcome = await MemoryService.extractFromChunk(session, chunk, job.source === 'manual' ? 'manual' : 'ai');
            commitExtraction(session, chunk.throughSeq, chunk.textLength);
            for (const bankId of outcome.touchedBanks) {
                enqueue({ kind: 'consolidate', bankId, source: job.source === 'manual' ? 'manual' : 'ai', priority: 2 });
            }
        }
        if (peekExtractionChunk(session)) {
            enqueue({ kind: 'extract', bankId: job.bankId, sessionId: job.sessionId, source: job.source, priority: 1 });
        }
        return;
    }
    if (job.kind === 'consolidate') {
        if (!configBool('OBSERVATION_ENABLED', true)) return;
        const outcome = await MemoryService.consolidateBank(job.bankId);
        if (configBool('MM_REFRESH_AFTER_CONSOLIDATION', false) && outcome.touchedTags.length) {
            enqueue({ kind: 'mm_refresh', bankId: job.bankId, source: 'ai', priority: 3, payload: { scopeTags: outcome.touchedTags } });
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

function configInt(key: string, fallback: number): number {
    const value = (Config.memory as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function hourlyLimit(): number {
    const value = configInt('BACKGROUND_HOURLY_LLM_CAP', 20);
    return value > 0 ? value : 20;
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

