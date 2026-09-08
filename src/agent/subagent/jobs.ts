// one-shot 后台子代理任务注册表（≈ dsh-jobs-local / dsh-tool-jobs 的最小可测实现）。
// 语义：job 有终态 done/killed/failed；kill 在运行中调用则终态为 killed（结果作废）；
// output(id) 等待终态并返回结果（failed 抛错）。
import type { SubAgentResult } from './types';

export type SubAgentJobStatus = 'running' | 'done' | 'killed' | 'failed';

export interface SubAgentJob {
    id: string;
    label: string;
    status: SubAgentJobStatus;
    startedAt: number;
    finishedAt?: number;
    result?: SubAgentResult;
    error?: string;
}

export interface SubAgentJobsOptions {
    now?: () => number;
    /** 记录保留上限（超出清理最旧终态记录；running 不清理）。默认 100 */
    retention?: number;
    /** job id 前缀 */
    prefix?: string;
}

export class SubAgentJobNotFoundError extends Error {
    constructor(id: string) {
        super(`subagent job not found: ${id}`);
        this.name = 'SubAgentJobNotFoundError';
    }
}

export class SubAgentJobs {
    private readonly jobs = new Map<string, SubAgentJob>();
    private readonly waiters = new Map<string, Array<() => void>>();
    private readonly now: () => number;
    private readonly retention: number;
    private readonly prefix: string;
    private seq = 0;

    constructor(opts: SubAgentJobsOptions = {}) {
        this.now = opts.now ?? Date.now;
        this.retention = opts.retention ?? 100;
        this.prefix = opts.prefix ?? 'subagent-job';
    }

    private notify(id: string): void {
        const ws = this.waiters.get(id);
        if (!ws) return;
        this.waiters.delete(id);
        for (const w of ws) w();
    }

    /**
     * 启动一个 job。run 返回 child 的终态结果；run 抛错 → job 终态 failed。
     * 返回 job id；kill 之后即便 run 完成，终态也保持 killed（结果作废）。
     */
    start(label: string, run: () => Promise<SubAgentResult>): string {
        this.seq++;
        const id = `${this.prefix}-${this.seq}`;
        const job: SubAgentJob = { id, label, status: 'running', startedAt: this.now() };
        this.jobs.set(id, job);
        void run().then(
            result => {
                const cur = this.jobs.get(id);
                if (!cur) return;
                if (cur.status !== 'killed') {
                    cur.status = 'done';
                    cur.result = result;
                    cur.finishedAt = this.now();
                } else {
                    cur.finishedAt = this.now();
                }
                this.notify(id);
                this.prune();
            },
            error => {
                const cur = this.jobs.get(id);
                if (!cur) return;
                if (cur.status !== 'killed') {
                    cur.status = 'failed';
                    cur.error = error instanceof Error ? error.message : String(error);
                    cur.finishedAt = this.now();
                } else {
                    cur.finishedAt = this.now();
                }
                this.notify(id);
                this.prune();
            }
        );
        return id;
    }

    list(): SubAgentJob[] {
        return Array.from(this.jobs.values()).sort((a, b) => a.startedAt - b.startedAt);
    }

    get(id: string): SubAgentJob | null {
        const j = this.jobs.get(id);
        return j ? { ...j, result: j.result, error: j.error } : null;
    }

    /** kill：仅对 running 生效；返回是否成功标记 */
    kill(id: string, reason?: string): boolean {
        const job = this.jobs.get(id);
        if (!job) return false;
        if (job.status !== 'running') return false;
        job.status = 'killed';
        job.error = reason ?? 'subagent job killed';
        job.finishedAt = this.now();
        this.notify(id);
        return true;
    }

    /** 等待终态并返回 job 快照；不存在则抛 SubAgentJobNotFoundError */
    async output(id: string): Promise<SubAgentJob> {
        const cur = this.jobs.get(id);
        if (!cur) throw new SubAgentJobNotFoundError(id);
        if (cur.status !== 'running') return { ...cur };
        await new Promise<void>(resolve => {
            const list = this.waiters.get(id) ?? [];
            list.push(resolve);
            this.waiters.set(id, list);
        });
        const after = this.jobs.get(id);
        if (!after) throw new SubAgentJobNotFoundError(id);
        return { ...after };
    }

    private prune(): void {
        if (this.retention <= 0 || this.jobs.size <= this.retention) return;
        const entries = Array.from(this.jobs.entries()).sort((a, b) => a[1].startedAt - b[1].startedAt);
        const overflow = this.jobs.size - this.retention;
        let dropped = 0;
        for (const [id, job] of entries) {
            if (dropped >= overflow) break;
            if (job.status === 'running') continue;
            this.jobs.delete(id);
            this.waiters.delete(id);
            dropped++;
        }
    }
}
