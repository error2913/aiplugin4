// 子代理工具集注册：委派（subagent/subagent_fork，前台或 one-shot 后台）+ 后台 job + 控制工具。
// 语义对齐 DSH：委派结果 stopReason 化；后台返回 job id；send_message/interrupt_agent/list_agents 面向 childId。
import { effectiveDeny, effectiveMaxDepth } from '../../../agent/subagent/limits';
import { resultErrorText } from '../../../agent/subagent/rules';
import type { StartRequest } from '../../../agent/subagent/types';
import { getSubAgentJobs, initSubAgentService, runContinuableActivation, sweepSubagentParent } from '../../../agent/subagent/wiring';
import Config from '../../../config/config';
import type { Session } from '../../../session/session';
import Tool from '../../tool';

const DEFAULT_PERSONA =
    '你是一名子代理。请独立完成交付的任务：分步推进、需要信息时自行调用可用工具；'
    + '你拥有与主会话相同的工具能力，仅当任务本身需要时才使用对外发送/管理类工具；'
    + '不确定时明确说明而不编造；完成后给出最终结论。';

const FOREGROUND_DESC = (fork: boolean): string => (fork
    ? '把任务委派给一个继承本会话已完成轮次的子代理（fork）：它能看到已完成对话、看不到当前正在执行的这一轮；结果只回最终文本。'
    : '把一段独立工作委派给子代理（spawn）：子代理看不到本会话历史，任务必须自包含；结果只回最终文本。'
    + ' 需要较长检索/归纳/多步分析时可使用。');

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
        label: ((args.description ?? args.prompt.slice(0, 20)) || '子代理任务').slice(0, 40),
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
            description: FOREGROUND_DESC(fork) + ' run_in_background=true 后台执行返回 job id；continuable=true 建可续跑子代理并立即返回子代理 id（可 send_message/interrupt_agent）。',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: fork
                            ? '要子代理继续做的事（它已看到本会话已完成轮次，只写新增目标即可）'
                            : '自包含的任务描述：子代理看不到本会话历史，背景/目标/产出格式都要写全',
                    },
                    description: { type: 'string', description: '3-5 词的任务摘要（展示/审计用）' },
                    persona: { type: 'string', description: '可选的子代理人设（覆盖默认），如"你是资料整理助手"' },
                    run_in_background: { type: 'boolean', description: '默认前台等待；true=后台执行并返回 job id' },
                    continuable: { type: 'boolean', description: 'true=建立可续跑子代理并立即返回 id（后续可 send_message 续派 / interrupt_agent 打断）' },
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
            description: '列出后台子代理 job（id/用途/状态）。',
            params: {},
        },
        {
            name: 'job_output',
            description: '等待一个后台子代理 job 结束并返回结果（completed 回文本，否则回错误与停止原因）。',
            params: { job_id: { type: 'string', required: true, description: 'job id（如 subagent-job-1）' } },
        },
        {
            name: 'job_kill',
            description: '取消一个仍在运行的后台子代理 job（终态 killed，结果作废）。',
            params: {
                job_id: { type: 'string', required: true, description: 'job id' },
                reason: { type: 'string', description: '取消原因' },
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
            description: '向一个子代理投递消息：运行中则在下一步前生效（steer），空闲则唤醒再跑一轮。只对直接子代理有效。',
            required: ['agent_id', 'message'],
        },
        {
            name: 'interrupt_agent',
            description: '请求中断一个子代理的当前轮（只停当前轮，agent 保留可再唤醒）。',
            required: ['agent_id'],
        },
        {
            name: 'list_agents',
            description: '列出本会话子树下的子代理（id/用途/状态/轮次结论摘要）。',
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
                        agent_id: { type: 'string', description: '子代理 id（sub:<父会话>:<序号>）' },
                        message: { type: 'string', description: '要投递的消息（send_message）' },
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
    Tool.withCategory('子代理', () => {
        registerDelegate(false);
        registerDelegate(true);
        registerJobTools();
        registerControlTools();
    });
}
