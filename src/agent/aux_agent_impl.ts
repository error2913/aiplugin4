// AuxAgent 端口实现（L3）：原生 tool_calls 循环（方案 §10.6）。
//
// 设计取舍：
// - 复用 streamService.sendChatRequest（不复制 agent/subagent 的提示词工程解析器）；
//   但 sendChatRequest 只在 `Config.tool.STATUS && !Config.tool.PROMPT_ENGINEERING` 时下发 tools
//   （agent/stream.ts:196-199）。本文件**不改 stream.ts**：当该门限关闭时降级为「本次无工具」
//   的单轮请求并打日志 —— 与方案「模型不支持原生 tools → 本次无工具（日志）」一致；
//   提示词工程模式下要真正带工具，需要独立请求构造或显式覆盖门限，留给 Lead 决策（见报告）。
// - 工具执行走 L0 注册表的适配器 handler；参数校验/超时/写操作次数/结果截断都在本文件（invoker 职责），
//   不重复 executor 的审计（内置工具自身/适配器各自记录）。
// - 不 import memory/context：只经 core/ports/session_lookup 取真实 Session（不伪造）。
import Config from '../config/config';
import { setAuxAgent } from '../core/ports/aux_agent';
import type { AuxAgent, AuxAgentRunOptions } from '../core/ports/aux_agent';
import { auxRegistry } from '../core/ports/aux_tools';
import type { AuxToolDescriptor, AuxToolEnv } from '../core/ports/aux_tools';
import { getSessionById } from '../core/ports/session_lookup';
import { logger } from '../logger';
import Model from '../model/model';
import type { ChatModelUse } from '../model/types';
import type { ToolCall } from '../tool/types';
import { fixJsonString } from '../utils/json';
import type { RequestMessage } from '../utils/message';
import { buildChildToolTruncateMarker } from '../utils/protocol';
import { truncateToTokenBudget } from '../utils/token_budget';
import { estimateTextTokens } from '../utils/token_estimate';

import { streamService } from './stream';

const log = logger.withTag('aux-agent');

/** 单次工具执行超时上限（秒）；总超时由 opts.timeoutSec 控制 */
const TOOL_TIMEOUT_SEC = 10;
/** 单次 run 内写工具最多执行次数（方案 §10.6：写操作每次 ≤2 次，失败不重试） */
const MAX_WRITE_CALLS = 2;
/** 单次 run 内工具执行总次数上限（防模型无限循环，独立于轮数） */
const MAX_TOOL_EXECUTIONS = 6;

/** 原生 tools 门限是否开启（与 stream.ts 同一判断；门限关闭时不发 tools） */
function nativeToolsAllowed(): boolean {
    const { STATUS, PROMPT_ENGINEERING } = Config.tool;
    return !!STATUS && !PROMPT_ENGINEERING;
}

/** 摘要工具总开关 + toolset 白名单（配置「启用摘要智能体工具」「摘要智能体工具集」） */
function toolsetEnabled(toolset: AuxAgentRunOptions['toolset']): boolean {
    const cfg = Config.tool as unknown as {
        SUMMARY_AGENT_TOOLS?: boolean;
        SUMMARY_AGENT_TOOLSETS?: string[];
    };
    if (!cfg.SUMMARY_AGENT_TOOLS) return false;
    const allowed = Array.isArray(cfg.SUMMARY_AGENT_TOOLSETS) ? cfg.SUMMARY_AGENT_TOOLSETS : [];
    return allowed.includes(toolset);
}

/** 带清理定时器的超时竞速（不用 withTimeout：其在成功分支不 clearTimeout，Node 下会拖住事件循环） */
function raceWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`操作超时 (${timeoutMs}ms)`));
        }, Math.max(1, timeoutMs));
        fn().then(
            value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer as unknown as number);
                resolve(value);
            },
            error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer as unknown as number);
                reject(error);
            },
        );
    });
}

/** 输入消息按 token 预算裁剪：保留全部 system + 从最新往前填，最新一条必留（0=不裁剪） */
function fitMessages(messages: RequestMessage[], tokenBudget?: number): RequestMessage[] {
    const budget = Number(tokenBudget) || 0;
    if (budget <= 0) return messages;
    const total = messages.reduce((acc, message) => acc + estimateTextTokens(String(message.content || '')), 0);
    if (total <= budget) return messages;
    const head: RequestMessage[] = [];
    const rest: RequestMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') head.push(message);
        else rest.push(message);
    }
    let used = head.reduce((acc, message) => acc + estimateTextTokens(String(message.content || '')), 0);
    const kept: RequestMessage[] = [];
    for (let i = rest.length - 1; i >= 0; i--) {
        const tokens = estimateTextTokens(String(rest[i].content || ''));
        // 最新一条无论如何保留（否则模型没有输入可直接回答）
        if (kept.length > 0 && used + tokens > budget) break;
        kept.push(rest[i]);
        used += tokens;
    }
    kept.reverse();
    return head.concat(kept);
}

/** 工具结果回填前按「工具结果展示token上限」截断（0=关闭）；辅助调用没有 read_raw，提示用工具分页 */
function clipToolResult(content: string): string {
    const maxTokens = Config.tool.TOOL_RESULT_MAX_TOKENS;
    if (maxTokens <= 0) return content;
    const source = String(content ?? '');
    const slice = truncateToTokenBudget(source, maxTokens, estimateTextTokens);
    return slice.truncated ? `${slice.text}${buildChildToolTruncateMarker(slice.totalTokens, slice.shownTokens)}` : source;
}

/** 由 descriptor 的 JSON Schema 做最小参数校验（required + 基本类型），返回错误文本或空 */
function validateToolArgs(tool: AuxToolDescriptor, args: Record<string, unknown>): string {
    const schema = (tool.parameters || {}) as { required?: unknown; properties?: Record<string, { type?: string }> };
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) return `Missing required parameter "${key}".`;
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, raw] of Object.entries(args)) {
        const expected = properties[key]?.type;
        if (!expected) continue;
        const value = raw;
        if (expected === 'string' && typeof value !== 'string') return `Parameter "${key}" must be a string.`;
        if (expected === 'number' && typeof value !== 'number') return `Parameter "${key}" must be a number.`;
        if (expected === 'boolean' && typeof value !== 'boolean') return `Parameter "${key}" must be a boolean.`;
        if (expected === 'array' && !Array.isArray(value)) return `Parameter "${key}" must be an array.`;
        if (expected === 'object' && (typeof value !== 'object' || value === null)) return `Parameter "${key}" must be an object.`;
    }
    return '';
}

/** 解析模型给的 arguments（字符串 JSON；失败尝试修复）；返回 null 表示无法解析 */
function parseToolArgs(raw: unknown): Record<string, unknown> | null {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    const text = typeof raw === 'string' ? raw : '';
    for (const candidate of [text, fixJsonString(text)]) {
        if (!candidate) continue;
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch {
            // 尝试下一个候选
        }
    }
    return null;
}

/** 描述符 → OpenAI tools 定义 */
function toToolInfo(tool: AuxToolDescriptor): Record<string, unknown> {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    };
}

/** 尝试按 context.sessionId 取真实会话（不伪造；测试/未初始化时返回 undefined） */
function resolveSession(context?: AuxAgentRunOptions['context']): unknown {
    if (!context?.sessionId) return undefined;
    try {
        return getSessionById(context.sessionId);
    } catch (e) {
        log.warning(`辅助调用取会话失败（needsContext 工具将不可用）：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
    }
}

class AuxAgentImpl implements AuxAgent {
    async runWithTools(
        agentName: string,
        messages: { role: string; content: string }[],
        opts: AuxAgentRunOptions,
    ): Promise<string> {
        const toolset = opts.toolset;
        const requestedRounds = Math.max(1, Math.min(10, Math.floor(Number(opts.maxRounds) || Number(Config.tool.SUMMARY_MAX_ROUNDS) || 3)));
        const timeoutSec = Math.max(1, Number(opts.timeoutSec) || 30);
        const deadline = Date.now() + timeoutSec * 1000;

        // 工具面：总开关 → toolset 白名单 → needsContext 过滤（无 context 时隐藏）
        const wantTools = toolsetEnabled(toolset);
        const view = wantTools ? auxRegistry.viewFor('summarizer', toolset) : { tools: [], snippets: [] };
        const tools = view.tools.filter(tool => !tool.needsContext || !!opts.context);
        const toolByName = new Map(tools.map(tool => [tool.name, tool]));
        const toolInfos = tools.map(toToolInfo);
        const gate = nativeToolsAllowed();
        if (tools.length > 0 && !gate) {
            // 与方案 §10.6 门限说明一致：提示词工程/函数调用关闭时本次无工具（日志一次）
            log.warning('辅助智能体工具被 stream 门限关闭（需「开启调用函数功能」且关闭「提示词工程」）：本次按无工具运行');
        }
        const nativeTools = gate ? toolInfos : [];

        const convo: RequestMessage[] = fitMessages(
            messages.map(message => ({ role: String(message.role || 'user'), content: String(message.content ?? '') })),
            opts.tokenBudget,
        );
        const env: AuxToolEnv = { context: opts.context, session: resolveSession(opts.context) };
        const runId = `aux:${agentName}:${Date.now().toString(36)}`;
        // 摘要场景优先用 summarization 模型；未配置时回退 chat 模型（与 AuxLlm 的 Agent.get 语义一致）
        const summarizationModel = Model.getChatModel('summarization');
        const model = summarizationModel || Model.getChatModel('chat');
        const use: ChatModelUse = summarizationModel ? 'summarization' : 'chat';

        let lastText = '';
        let writeCalls = 0;
        let toolExecutions = 0;

        // 最多 maxRounds 轮工具 + 最后一轮无工具收尾（保证一定有最终文本）
        for (let round = 0; round <= requestedRounds; round++) {
            if (Date.now() > deadline) break;
            const allowTools = round < requestedRounds && nativeTools.length > 0;
            const response = await streamService.sendChatRequest(
                convo,
                allowTools ? nativeTools : [],
                allowTools ? 'auto' : 'none',
                runId,
                model,
                undefined,
                { use, stream: false },
            );
            const content = String(response.content || '');
            if (content) lastText = content;
            const calls: ToolCall[] = Array.isArray(response.tool_calls) ? response.tool_calls : [];
            if (!allowTools || calls.length === 0) return content || lastText;

            // assistant 消息必须原样带上 tool_calls（含 thinking 模型的 reasoning_content），否则回填请求 400
            const assistant: RequestMessage = { role: 'assistant', content };
            assistant.tool_calls = calls;
            if (response.reasoning_content !== undefined) assistant.reasoning_content = response.reasoning_content;
            convo.push(assistant);

            for (const call of calls) {
                if (toolExecutions >= MAX_TOOL_EXECUTIONS) {
                    convo.push({ role: 'tool', tool_call_id: call.id, content: 'Tool call budget exhausted; finish with the information you already have.' });
                    continue;
                }
                const name = call.function?.name || '';
                const tool = toolByName.get(name);
                const handler = auxRegistry.handler(name);
                if (!tool || !handler) {
                    convo.push({ role: 'tool', tool_call_id: call.id, content: `Unknown tool "${name}" in this auxiliary toolset.` });
                    continue;
                }
                if (tool.risk !== 'read') {
                    if (writeCalls >= MAX_WRITE_CALLS) {
                        convo.push({ role: 'tool', tool_call_id: call.id, content: 'Write-operation limit reached for this auxiliary call; no further writes this turn.' });
                        continue;
                    }
                    writeCalls++;
                }
                const args = parseToolArgs(call.function?.arguments);
                if (!args) {
                    convo.push({ role: 'tool', tool_call_id: call.id, content: `Invalid arguments for "${name}": expected a JSON object.` });
                    continue;
                }
                const invalid = validateToolArgs(tool, args);
                if (invalid) {
                    convo.push({ role: 'tool', tool_call_id: call.id, content: invalid });
                    continue;
                }
                toolExecutions++;
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    convo.push({ role: 'tool', tool_call_id: call.id, content: 'Auxiliary tool budget exceeded; finishing.' });
                    break;
                }
                let output = '';
                try {
                    // 写操作失败不重试：异常直接作为错误文本回填（方案 §10.6）
                    output = await raceWithTimeout(
                        () => handler(args, env),
                        Math.min(remaining, TOOL_TIMEOUT_SEC * 1000),
                    );
                } catch (e) {
                    output = `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`;
                }
                convo.push({ role: 'tool', tool_call_id: call.id, content: clipToolResult(String(output ?? '')) });
            }
        }
        return lastText;
    }
}

/** 由组合根注入（与 installAuxLlm 同一装配位置；M2 需要在摘要调用前调用） */
export function installAuxAgent(): void {
    setAuxAgent(new AuxAgentImpl());
}
