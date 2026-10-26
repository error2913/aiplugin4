// 子代理工具集注册：委派（subagent/subagent_fork，前台或 one-shot 后台）+ 后台 job + 控制工具。
// 语义对齐 DSH：委派结果 stopReason 化；后台返回 job id；send_message/interrupt_agent/list_agents 面向 childId。
import Config from '../../../config/config';
import type { Session } from '../../../session/session';
import {
    effectiveDeny,
    effectiveMaxDepth,
    getSubAgentJobs,
    initSubAgentService,
    resultErrorText,
    runContinuableActivation,
    type StartRequest,
    sweepSubagentParent,
} from '../../../subagent';
import Tool from '../../tool';

const DEFAULT_PERSONA =
    'You are a subagent. Complete the assigned task independently: proceed step by step and call available tools when you need information; '
    + 'you have the same tool capabilities as the main session, and should use external-send/management tools only when the task itself requires them; '
    + 'state uncertainty explicitly instead of making things up; finish with a final conclusion.';

const FOREGROUND_DESC = (fork: boolean): string => (fork
    ? 'Delegate the task to a subagent that inherits this session completed turns (fork): it sees the completed conversation but not the turn currently executing; only the final text is returned.'
    : 'Delegate an independent piece of work to a subagent (spawn): the subagent does not see this session history, so the task must be self-contained; only the final text is returned.'
    + ' Use it when longer retrieval/summarization/multi-step analysis is needed.');

interface ToolArgs {
    prompt: string;
    description?: string;
    persona?: string;
    run_in_background?: boolean;
    continuable?: boolean;
}

function buildRequest(ctx: seal.MsgContext, msg: seal.Message, session: Session, args: ToolArgs): StartRequest {
    const settings = Config.subagent;
    const deny = effectiveDeny(settings.DENY_TOOLS);
    return {
        label: ((args.description ?? args.prompt.slice(0, 20)) || 'subagent task').slice(0, 40),
        prompt: args.prompt,
        parent: {
            sessionId: session.sessionId,
            epId: ctx.endPoint.userId,
            isPrivate: ctx.isPrivate,
            depth: session.subagentDepth,
        },
        persona: args.persona && args.persona !== '' ? args.persona : DEFAULT_PERSONA,
        // 深度：主会话按配置；child 默认不可再委派（放开需补根归属透传）
        maxDepth: effectiveMaxDepth(settings.MAX_DEPTH, session.subagentDepth),
        ...(deny ? { toolFilter: { deny } } : {}),
        runtime: { ctx, msg, parentSession: session } as unknown,
    };
}

function labelOf(req: StartRequest): string {
    return req.label || req.prompt.slice(0, 20);
}

function registerDelegate(fork: boolean): void {
    const name = fork ? 'subagent_fork' : 'subagent';
    const tool = new Tool({
        type: 'function',
        function: {
            name,
            description: FOREGROUND_DESC(fork) + ' run_in_background=true runs in the background and returns a job id; continuable=true creates a continuable subagent and returns its id immediately (send_message/interrupt_agent available).',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: fork
                            ? 'What the subagent should continue with (it already sees this session completed turns, so just write the new goal)'
                            : 'Self-contained task description: the subagent cannot see this session history, so write background/goal/output format in full',
                    },
                    description: { type: 'string', description: 'Task summary in 3-5 words (for display/audit)' },
                    persona: { type: 'string', description: 'Optional subagent persona (overrides the default), e.g. "you are a research assistant"' },
                    run_in_background: { type: 'boolean', description: 'Wait in foreground by default; true=run in background and return a job id' },
                    continuable: { type: 'boolean', description: 'true=create a continuable subagent and return its id immediately (later send_message to continue / interrupt_agent to interrupt)' },
                },
                required: ['prompt'],
            },
        },
    });
    tool.sessionType = 'any';
    tool.solve = async (ctx, msg, session, args: any) => {
        if (!session) return '子代理调用失败：缺少会话上下文';
        if (Config.subagent.ENABLE === false) return '子代理功能未开启（配置：「子代理」分组）';
        const svc = initSubAgentService();
        const req = buildRequest(ctx, msg, session, args);
        const providerName = fork ? 'fork' : 'spawn';
        if (args.continuable === true) {
            const { childId } = await svc.startContinuable(providerName, req);
            const ref = { ctx, msg, parentSession: session };
            void runContinuableActivation(childId, req.prompt, ref).catch(() => { /* 结算已在函数内兜底 */ });
            return `started subagent ${childId}`;
        }
        if (args.run_in_background === true) {
            const jobId = getSubAgentJobs().start(labelOf(req), async () => (await svc.startForeground(providerName, req)).result);
            return `started background subagent job ${jobId}`;
        }
        try {
            const { result } = await svc.startForeground(providerName, req);
            if (result.stopReason === 'completed') {
                const text = (result.output ?? '').trim();
                return text !== '' ? text : '（子代理无文字输出）';
            }
            return `子代理执行失败：${resultErrorText(result) || result.stopReason}`;
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            return `子代理调用失败：${detail}`;
        }
    };
}

function registerJobTools(): void {
    type Param = { type: 'string'; required?: boolean; description: string };
    const defs: Array<{ name: string; description: string; params: Record<string, Param> }> = [
        {
            name: 'job_list',
            description: 'List background subagent jobs (id/purpose/status).',
            params: {},
        },
        {
            name: 'job_output',
            description: 'Wait for a background subagent job to finish and return its result (text on completed, otherwise the error and stop reason).',
            params: { job_id: { type: 'string', required: true, description: 'job id (e.g. subagent-job-1)' } },
        },
        {
            name: 'job_kill',
            description: 'Cancel a running background subagent job (final state killed; result discarded).',
            params: {
                job_id: { type: 'string', required: true, description: 'job id' },
                reason: { type: 'string', description: 'Cancellation reason' },
            },
        },
    ];
    for (const def of defs) {
        const tool = new Tool({
            type: 'function',
            function: {
                name: def.name,
                description: def.description,
                parameters: {
                    type: 'object',
                    properties: def.params,
                    required: Object.keys(def.params).filter(k => def.params[k].required),
                },
            },
        });
        tool.sessionType = 'any';
        tool.solve = async (_ctx, _msg, _session, args: { job_id?: string; reason?: string }) => {
            const jobs = getSubAgentJobs();
            try {
                if (def.name === 'job_list') {
                    const list = jobs.list();
                    if (list.length === 0) return '（没有后台子代理 job）';
                    return list.map(j => `${j.id}\t${j.label}\t${j.status}`).join('\n');
                }
                const id = args.job_id ?? '';
                if (def.name === 'job_kill') {
                    const ok = jobs.kill(id, args.reason ?? 'cancelled by user');
                    return ok ? `job ${id} 已取消` : `job ${id} 不存在或已结束`;
                }
                const job = await jobs.output(id);
                if (job.status === 'done' && job.result) {
                    if (job.result.stopReason === 'completed') {
                        return job.result.output !== '' ? job.result.output : '（子代理无文字输出）';
                    }
                    return `子代理执行失败：${resultErrorText(job.result) || job.result.stopReason}`;
                }
                if (job.status === 'killed') return `job ${id} 已取消：${job.error ?? ''}`.trim();
                return `job ${id} 失败：${job.error ?? job.status}`;
            } catch (e) {
                const detail = e instanceof Error ? e.message : String(e);
                return `${def.name} 失败：${detail}`;
            }
        };
    }
}

function registerControlTools(): void {
    const svc = initSubAgentService();
    const defs = [
        {
            name: 'send_message',
            description: 'Deliver a message to a subagent: if it is running, applied before its next step (steer); if idle, wake it for another round. Only applies to direct subagents.',
            required: ['agent_id', 'message'],
        },
        {
            name: 'interrupt_agent',
            description: 'Request interruption of a subagent\'s current turn (only that turn stops; the agent can be woken again).',
            required: ['agent_id'],
        },
        {
            name: 'list_agents',
            description: 'List subagents under this session subtree (id/purpose/status/round conclusion summary).',
            required: [] as string[],
        },
    ];
    for (const def of defs) {
        const tool = new Tool({
            type: 'function',
            function: {
                name: def.name,
                description: def.description,
                parameters: {
                    type: 'object',
                    properties: {
                        agent_id: { type: 'string', description: 'Subagent id (sub:<parent session>:<sequence>)' },
                        message: { type: 'string', description: 'Message to deliver (send_message)' },
                    },
                    required: def.required,
                },
            },
        });
        tool.sessionType = 'any';
        tool.solve = async (ctx, msg, session, args: { agent_id?: string; message?: string }) => {
            const agentId = args.agent_id ?? '';
            try {
                if (def.name === 'send_message') {
                    const rec = svc.getRecord(agentId);
                    if (!rec) return `send_message 失败：子代理不存在 ${agentId}`;
                    if (rec.status === 'done' || rec.status === 'stopped') {
                        return `send_message 失败：子代理 ${agentId} 已${rec.status}，不再唤醒`;
                    }
                    svc.sendMessage(agentId, session.sessionId, args.message ?? '');
                    // idle/interrupted（含重载后“已中断·可续”）→ 从 checkpoint 续跑一轮
                    if (rec.status === 'idle' || rec.status === 'interrupted') {
                        const queued = svc.drainInbox(agentId);
                        if (queued.length > 0) {
                            void runContinuableActivation(agentId, queued.join('\n'), { ctx, msg, parentSession: session })
                                .catch(() => undefined);
                        }
                    }
                    return `message delivered to agent ${agentId}`;
                }
                if (def.name === 'interrupt_agent') {
                    svc.interrupt(agentId, session.sessionId);
                    return `interrupt requested for agent ${agentId}`;
                }
                const scope = session.subagentDepth === 0 ? session.sessionId : session.parentSessionId;
                sweepSubagentParent(scope || session.sessionId); // 查看前先收敛（父上下文已遗忘的清理）
                const records = svc.listByParent(scope || session.sessionId);
                if (records.length === 0) return '（本会话没有子代理）';
                return records.map(r => `${r.childId}\t${r.label}\t${r.status}`).join('\n');
            } catch (e) {
                const detail = e instanceof Error ? e.message : String(e);
                return `${def.name} 失败：${detail}`;
            }
        };
    }
}

export function registerSubagentTools(): void {
    Tool.withCategory('Subagents', () => {
        registerDelegate(false);
        registerDelegate(true);
        registerJobTools();
        registerControlTools();
    });
}
