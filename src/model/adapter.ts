// 模型适配层：不同 API 提供商的请求体与响应格式互转（当前支持 anthropic）
import { ToolCall } from "../tool/types";

export interface NormalizedChatResponse {
    choices: Array<{
        index: number,
        finish_reason: string | null,
        message: {
            role: string,
            content: string,
            reasoning_content?: string,
            tool_calls?: ToolCall[]
        }
    }>,
    model?: string,
    usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number }
}

const ANTHROPIC_FINISH_REASON_MAP: { [key: string]: string } = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    pause_turn: 'stop',
    refusal: 'content_filter'
};

/** 按提供商转换请求体：默认 OpenAI 兼容格式原样透传 */
export function buildProviderBody(provider: string, body: any): any {
    if (provider === 'anthropic') return buildAnthropicBody(body);
    return body;
}

/** 按提供商归一化响应：默认 OpenAI 兼容格式原样透传 */
export function parseProviderResponse(provider: string, data: any): NormalizedChatResponse {
    if (provider === 'anthropic') return parseAnthropicResponse(data);
    return data;
}

/** 提取统一格式的用量（兼容 anthropic 的 input/output_tokens 与 OpenAI 的 prompt/completion_tokens） */
export function extractUsage(data: any): { prompt_tokens: number, completion_tokens: number, total_tokens: number } | undefined {
    if (!data || !data.usage) return undefined;
    const u = data.usage;
    const prompt = u.input_tokens ?? u.prompt_tokens ?? 0;
    const completion = u.output_tokens ?? u.completion_tokens ?? 0;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: u.total_tokens ?? (prompt + completion)
    };
}

/** OpenAI 格式请求体 → Anthropic Messages 格式 */
function buildAnthropicBody(body: any): any {
    const { system, messages } = buildAnthropicMessages(body.messages || []);
    const out: any = {
        model: body.model,
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
        messages
    };
    if (system) out.system = system;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        out.tools = body.tools.map((t: any) => {
            const fn = t.function || {};
            return {
                name: fn.name,
                description: fn.description || '',
                input_schema: fn.parameters || { type: 'object', properties: {} }
            };
        });
    }
    if (body.tool_choice) out.tool_choice = convertAnthropicToolChoice(body.tool_choice);
    if (Array.isArray(body.stop) && body.stop.length > 0) out.stop_sequences = body.stop;
    else if (typeof body.stop === 'string' && body.stop) out.stop_sequences = [body.stop];
    if (typeof body.temperature === 'number') out.temperature = body.temperature;
    if (typeof body.top_p === 'number') out.top_p = body.top_p;
    if (typeof body.top_k === 'number') out.top_k = body.top_k;
    if (body.stream) out.stream = true;
    if (body.thinking) out.thinking = body.thinking;
    if (body.metadata) out.metadata = body.metadata;
    return out;
}

function convertAnthropicToolChoice(toolChoice: any): any {
    if (toolChoice === 'required' || toolChoice === 'any') return 'any';
    if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
    if (toolChoice && toolChoice.type === 'function') {
        return { type: 'tool', name: toolChoice.function?.name };
    }
    return 'auto';
}

/** OpenAI messages → Anthropic messages（system 拆出、tool 结果合并为 user/tool_result、连续同角色合并） */
function buildAnthropicMessages(messages: any[]): { system: string, messages: any[] } {
    const systemParts: string[] = [];
    const out: any[] = [];

    for (const msg of messages || []) {
        const role = msg.role;
        if (role === 'system') {
            const text = extractSystemText(msg.content);
            if (text) systemParts.push(text);
            continue;
        }
        if (role === 'tool') {
            const text = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
            out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: text }] });
            continue;
        }
        let content: any = msg.content;
        // 多模态内容块：OpenAI image_url → Anthropic image（base64 或 url 两种 source）
        if (Array.isArray(content)) {
            content = content.map((block: any) => {
                if (block.type === 'image_url') {
                    const url = (block.image_url && block.image_url.url) || '';
                    const m = url.match(/^data:image\/([^;]+);base64,(.+)$/);
                    if (m) {
                        return {
                            type: 'image',
                            source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2] }
                        };
                    }
                    return { type: 'image', source: { type: 'url', url } };
                }
                if (block.type === 'text') return { type: 'text', text: block.text };
                return block;
            });
        }
        if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const blocks: any[] = [];
            if (msg.content) blocks.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' });
            for (const tc of msg.tool_calls) {
                let input: any = {};
                try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
            }
            content = blocks;
        }
        // DeepSeek 思维链 → Anthropic thinking 块：thinking 必须位于消息块最前，且每条消息最多一个
        if (role === 'assistant' && typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== '') {
            const blocks = Array.isArray(content) ? content.slice() : (typeof content === 'string' && content ? [{ type: 'text', text: content }] : []);
            blocks.unshift({ type: 'thinking', thinking: msg.reasoning_content });
            content = blocks;
        }
        out.push({ role, content });
    }

    // Anthropic 要求 user/assistant 交替，合并连续同角色消息
    const merged: any[] = [];
    for (const msg of out) {
        const last = merged[merged.length - 1];
        if (last && last.role === msg.role) {
            last.content = mergeAnthropicContent(last.content, msg.content);
        } else {
            merged.push({ role: msg.role, content: msg.content });
        }
    }

    return { system: systemParts.join('\n'), messages: merged };
}

/** 提取 system 消息文本：支持纯字符串与 OpenAI 多模态内容块数组（仅拼接 text 块） */
function extractSystemText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
    }
    return '';
}

function mergeAnthropicContent(a: any, b: any): any {
    const toBlocks = (c: any): any[] => typeof c === 'string' ? [{ type: 'text', text: c }] : (Array.isArray(c) ? c : []);
    const aBlocks = toBlocks(a);
    const bBlocks = toBlocks(b);
    // Anthropic 每条消息最多一个 thinking 块：thinking 恒在消息块最前，
    // 合并相邻 assistant 消息时取两条消息的首块判断并合并，而不是末尾块
    const firstA = aBlocks[0];
    const firstB = bBlocks[0];
    if (firstA && firstB && firstA.type === 'thinking' && firstB.type === 'thinking') {
        firstA.thinking = (firstA.thinking || '') + '\n' + (firstB.thinking || '');
        bBlocks.shift();
    }
    return aBlocks.concat(bBlocks);
}

/** Anthropic Messages 响应 → OpenAI 兼容结构（choices/message/content/tool_calls） */
function parseAnthropicResponse(data: any): NormalizedChatResponse {
    const blocks = Array.isArray(data.content) ? data.content : [];
    const content = blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text || '')
        .join('');
    const reasoningContent = blocks
        .filter((b: any) => b.type === 'thinking')
        .map((b: any) => b.thinking || '')
        .join('');
    const toolCalls: ToolCall[] = blocks
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any, index: number) => ({
            index,
            id: b.id || '',
            type: 'function' as const,
            function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) }
        }));

    const message: { role: string, content: string, reasoning_content?: string, tool_calls?: ToolCall[] } = {
        role: data.role || 'assistant',
        content
    };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
        choices: [{
            index: 0,
            finish_reason: ANTHROPIC_FINISH_REASON_MAP[data.stop_reason] || data.stop_reason || null,
            message
        }],
        model: data.model,
        usage: extractUsage(data)
    };
}

