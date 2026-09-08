// headless child 激活循环（对接层，不在 unit-test 纯机制集内导出）。
// 语义与主链 runInternal 对齐，但：不 acquire requestLimiter、不向聊天发送、
// 本地 RequestMessage 数组装配（不复用持久化 Context）、stopEvent=child.stopEvent。
// 中断（interrupt/.ai stop）由服务层 fireStopEvent(child.stopEvent) 触发 → 循环抛 StopError → aborted。
import { streamService } from '../../agent/stream';
import Config from '../../config/config';
import Logger from '../../logger';
import type { ApiError } from '../../model/api_error';
import Model from '../../model/model';
import type { ChatModelUse } from '../../model/types';
import { Session } from '../../session/session';
import { ToolRunner } from '../../tool/runner';
import Tool from '../../tool/tool';
import type { RequestMessage } from '../../utils/message';
import { buildContent } from '../../utils/message';
import { StopError } from '../../utils/utils';

import { completedTurnPrefixCount } from './rules';
import type { ToolFilter } from './types';
import type { SubAgentResult } from './types';


const log = Logger.withTag('subagent');

export interface NewChildSessionOptions {
    sessionId: string;
    parentSessionId: string;
    isPrivate: boolean;
    depth: number;
    agentName?: string;
    /** 父会话当前 toolState 快照（全量继承底）；缺省则由 toolState getter 按配置默认 */
    toolStateSnapshot?: Record<string, boolean>;
    toolFilter?: ToolFilter | null;
}

export interface ActivationInput {
    ctx: seal.MsgContext;
    msg: seal.Message;
    child: Session;
    systemText: string;
    /** 委派任务文本 */
    task: string;
    use: ChatModelUse;
    /** 最大模型轮次（含工具轮）；缺省 8 */
    maxTurns?: number;
    /** 本轮激活总预算（毫秒）；缺省 120000 */
    budgetMs?: number;
    /** fork seed：父已完成轮次的 RequestMessage 前缀（由调用方按需生成） */
    seed?: RequestMessage[];
    /** 续跑：从中断点 checkpoint 的消息续（提供时跳过默认装配，仅追加本轮新任务） */
    baseMessages?: RequestMessage[];
    /** 落盘回调：每轮开始前保存消息快照（对接层写 checkpoint；不丢内容） */
    checkpoint?: (messages: RequestMessage[]) => void | Promise<void>;
    /** 测试注入：替代 streamService.sendChatRequest（缺省走真实服务） */
    request?: (
        messages: RequestMessage[],
        tools: unknown[],
        toolChoice: string,
        runId: string,
        model: unknown,
        stopEvent: { fired: boolean }
    ) => Promise<{ content: string; tool_calls?: unknown[]; reasoning_content?: string }>;
    /** 测试注入：模型占位（缺省 Model.getChatModel(use)） */
    model?: unknown;
}

export function createChildSession(o: NewChildSessionOptions): Session {
    const session = new Session();
    session.sessionId = o.sessionId;
    session.sessionType = o.isPrivate ? 'user' : 'group';
    session.agentName = o.agentName ?? '';
    session.headless = true;
    session.parentSessionId = o.parentSessionId;
    session.subagentDepth = o.depth;
    if (o.toolStateSnapshot) session.tool.state = { ...o.toolStateSnapshot };
    session.toolRestriction = o.toolFilter ?? null;
    return session;
}

/** 父上下文已完成轮次 → 请求消息前缀（fork seed；深度拷贝文本与配对，由调用方在激活前生成） */
export function buildForkSeed(parentMessages: readonly unknown[], seedCount?: number): RequestMessage[] {
    const count = seedCount ?? completedTurnPrefixCount(parentMessages as { role: string; toolCalls?: unknown[] | null; tool_calls?: unknown[] | null }[]);
    const out: RequestMessage[] = [];
    for (let i = 0; i < count && i < parentMessages.length; i++) {
        const m = parentMessages[i] as Record<string, unknown> & {
            role: string;
            contentItems?: unknown[];
            text?: string;
            toolCalls?: Array<Record<string, unknown>> | null;
            tool_calls?: Array<Record<string, unknown>> | null;
            toolCallId?: string;
            tool_call_id?: string;
            reasoningContent?: string;
            reason_content?: string;
        };
        const toolCalls = m.toolCalls ?? m.tool_calls ?? null;
        if (m.role === 'tool') {
            const id = (m.toolCallId ?? m.tool_call_id ?? '') as string;
            if (id !== '') out.push({ role: 'tool', content: m.text ?? '', tool_call_id: id });
            continue;
        }
        if (toolCalls && toolCalls.length > 0) {
            out.push({
                role: 'assistant',
                content: '',
                tool_calls: toolCalls.map(tc => ({
                    id: String(tc.id ?? ''),
                    type: 'function',
                    function: {
                        name: String(((tc.function as Record<string, unknown>)?.name) ?? ''),
                        arguments: String(((tc.function as Record<string, unknown>)?.arguments) ?? ''),
                    },
                })),
            } as RequestMessage);
            continue;
        }
        const reasoning = m.reasoningContent ?? m.reason_content;
        const content = m.contentItems ? buildContent(m as never) : (m.text ?? '');
        const item: RequestMessage = { role: m.role as RequestMessage['role'], content: content as string };
        if (reasoning !== undefined) (item as { reasoning_content?: string }).reasoning_content = reasoning as string;
        if (item.role === 'assistant' || item.role === 'user') out.push(item);
    }
    return out;
}

function isStopped(session: { stopEvent: { fired: boolean } }): boolean {
    return session.stopEvent.fired;
}

function errorText(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

/**
 * 跑一个 child 激活直到终态：completed / aborted / timeout / error。
 * 调用前 child.resetState()（清工具计数）；child.stopEvent 由调用方在激活开始时 reset。
 */
export async function runHeadlessActivation(inp: ActivationInput): Promise<SubAgentResult> {
    const { ctx, msg, child, systemText, use } = inp;
    const { STATUS, PROMPT_ENGINEERING } = Config.tool;
    const maxTurns = inp.maxTurns ?? 8;
    const deadline = Date.now() + (inp.budgetMs ?? 120000);
    const runId = `sub:${child.sessionId}`;

    child.resetState();
    child.stopEvent.fired = false;

    const messages: RequestMessage[] = [];
    if (inp.baseMessages && inp.baseMessages.length > 0) {
        // 续跑：checkpoint 原样回放（含之前全部消息），仅追加本轮新任务
        messages.push(...inp.baseMessages);
    } else {
        messages.push({ role: 'system', content: systemText });
        if (inp.seed) messages.push(...inp.seed);
    }
    messages.push({ role: 'user', content: inp.task });

    /** 每轮开始前持久化一次快照（对接层写 checkpoint） */
    const commitCheckpoint = async () => {
        if (inp.checkpoint) await inp.checkpoint(messages.slice());
    };

    let turns = 0;
    let partial = '';
    const model = (inp.model as { name?: string } | null | undefined) ?? Model.getChatModel(use);
    if (!model) return { stopReason: 'error', output: '', diagnostic: '没有可用的对话模型' };

    for (;;) {
        await commitCheckpoint();
        if (isStopped(child)) return { stopReason: 'aborted', output: partial, diagnostic: 'interrupted by ancestor' };
        turns++;
        if (turns > maxTurns) return { stopReason: 'timeout', output: partial, diagnostic: `超过最大轮次 ${maxTurns}` };
        if (Date.now() > deadline) return { stopReason: 'timeout', output: partial, diagnostic: '超出预算时间' };

        // 工具 schema：原生模式只注入引导工具（经 child.toolState 过滤）；提示词工程模式不注入
        const tools = STATUS && !PROMPT_ENGINEERING ? Tool.getNativeRequestTools(child) ?? [] : [];

        let raw: { content: string; tool_calls?: unknown[]; reasoning_content?: string };
        try {
            const send = inp.request;
            const turn = send
                ? await send(messages, tools, 'auto', runId, model, child.stopEvent)
                : await streamService.sendChatRequest(messages, tools, 'auto', runId, model as never, child.stopEvent, { throwClassified: true, stream: false });
            raw = turn as { content: string; tool_calls?: unknown[]; reasoning_content?: string };
        } catch (e) {
            if (isStopped(child) || e instanceof StopError) {
                return { stopReason: 'aborted', output: partial, diagnostic: 'interrupted by ancestor' };
            }
            const diag = e instanceof Error && 'kind' in (e as ApiError) ? `kind=${(e as ApiError).kind}` : '';
            return { stopReason: 'error', output: partial, diagnostic: `${diag} ${errorText(e)}`.trim() };
        }

        const reasoning = raw.reasoning_content;
        if (PROMPT_ENGINEERING) {
            const contentText = raw.content ?? '';
            const match = contentText.match(/```function([\s\S]*?)```/);
            if (!match) {
                const text = contentText.trim();
                if (text !== '') partial = text;
                return { stopReason: 'completed', output: partial };
            }
            const idx = contentText.indexOf('```function');
            const pre = idx > 0 ? contentText.slice(0, idx).trim() : '';
            if (pre !== '') partial = partial !== '' ? `${partial}\n${pre}` : pre;
            messages.push({
                role: 'assistant',
                content: pre !== '' ? `${pre}\n${match[0]}` : match[0],
                ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
            });
            try {
                const results = await ToolRunner.executePromptCalls(ctx, msg, child, match[1]);
                let callBackAll = true;
                for (const r of results) {
                    if (r.callBack === false) callBackAll = false;
                    messages.push({ role: 'user', content: `【工具返回:${r.toolName ?? 'tool'}】${r.content}` });
                }
                if (!callBackAll) return { stopReason: 'completed', output: partial };
            } catch (e) {
                if (e instanceof StopError || isStopped(child)) return { stopReason: 'aborted', output: partial };
                log.exception('child prompt tool error', e);
                messages.push({ role: 'user', content: `【工具返回】子代理工具执行失败：${errorText(e)}` });
            }
            continue;
        }

        const toolCalls = (raw.tool_calls ?? []) as Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
        if (toolCalls.length === 0) {
            const text = (raw.content ?? '').trim();
            if (text !== '') partial = text;
            return { stopReason: 'completed', output: partial };
        }

        messages.push({
            role: 'assistant',
            content: '',
            tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
            ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
        } as RequestMessage);

        try {
            const results = await ToolRunner.executeFunctionCalls(ctx, msg, child, toolCalls.map((tc, index) => ({
                index,
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
            })));
            let callBackAll = true;
            for (const r of results) {
                if (r.callBack === false) callBackAll = false;
                messages.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content });
            }
            if (!callBackAll) return { stopReason: 'completed', output: partial };
        } catch (e) {
            if (e instanceof StopError || isStopped(child)) return { stopReason: 'aborted', output: partial };
            log.exception('child tool error', e);
            messages.push({ role: 'tool', tool_call_id: toolCalls[0]?.id ?? '', content: `子代理工具执行失败：${errorText(e)}` });
        }
    }
}

/** 落盘最小化消息：只保留续跑必需字段（内容/配对/思考链全量保留，不丢内容） */
export interface CheckpointMessage {
    role: string;
    content?: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    reasoning_content?: string;
}

export function encodeCheckpoint(messages: RequestMessage[]): CheckpointMessage[] {
    return messages.map(m => {
        const out: CheckpointMessage = { role: m.role as string };
        if (typeof m.content === 'string') out.content = m.content;
        const tcs = m.tool_calls;
        if (Array.isArray(tcs) && tcs.length > 0) {
            out.tool_calls = (tcs as unknown as Array<{ id: unknown; function?: { name?: unknown; arguments?: unknown } }>).map(tc => ({
                id: String(tc.id ?? ''),
                type: 'function' as const,
                function: {
                    name: String(tc.function?.name ?? ''),
                    arguments: String(tc.function?.arguments ?? ''),
                },
            }));
        }
        const item = m as unknown as { tool_call_id?: string; reasoning_content?: string };
        if (item.tool_call_id !== undefined) out.tool_call_id = item.tool_call_id;
        if (item.reasoning_content !== undefined) out.reasoning_content = item.reasoning_content;
        return out;
    });
}

export function decodeCheckpoint(list: CheckpointMessage[]): RequestMessage[] {
    return list.map(cm => {
        const out: Record<string, unknown> = { role: cm.role };
        if (cm.content !== undefined) out.content = cm.content;
        if (cm.tool_calls && cm.tool_calls.length > 0) {
            out.tool_calls = cm.tool_calls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
        }
        if (cm.tool_call_id !== undefined) out.tool_call_id = cm.tool_call_id;
        if (cm.reasoning_content !== undefined) out.reasoning_content = cm.reasoning_content;
        return out as unknown as RequestMessage;
    });
}
