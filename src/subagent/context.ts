// 子代理独立上下文：本地 RequestMessage[] 叠加 + 超过上限时自动压缩。
//
// 设计（.dev/context-v2-design.md §14.3 / context-v2-behavior.md §9）：
// - 子代理**不使用**主 ContextStore/事件账本，就是最简单的消息叠加；
// - 每轮请求前估算 token，超过「子代理上下文上限」才压一次：
//   保留 system + 最近约一半预算的原文，更早的压成一条摘要并入 system；
// - 压缩失败（摘要器缺失/抛错/返回空）→ 确定性降级：保留最近内容 + 明确的省略标记，
//   绝不静默丢、绝不拆工具调用组；
// - 本文件不得 import `src/context/**`；token 估算自带轻量实现，摘要器由调用方注入。
import type { RequestMessage } from '../utils/message';
import {
    EXISTING_SUMMARY_HEADER,
    SUBAGENT_OMIT_HEADER,
    SUBAGENT_SUMMARY_HEADER,
    SUBAGENT_TRUNCATE_MARK,
    subagentOmitLine,
} from '../utils/protocol';

/** 摘要器：把一段历史文本压成摘要（失败/返回空走降级路径）。maxTokens 为建议输出预算 */
export type SubAgentSummaryFn = (input: string, opts: { maxTokens: number }) => string | Promise<string>;

export interface SubAgentContextInit {
    /** 全新装配时的 system 提示词 */
    systemText: string;
    /** fork seed（父已完成轮次前缀）；spawn 不传 */
    seed?: RequestMessage[];
    /** 本轮任务文本（追加为一条 user 消息） */
    task: string;
    /** 续跑：checkpoint 回放的消息（提供时忽略 systemText/seed，只追加 task） */
    baseMessages?: RequestMessage[];
    /** token 上限；<=0 表示不压缩（调用方负责把配置 0 解析成模型窗口×0.8） */
    maxTokens: number;
    /** 压缩后保留最近内容的预算比例（默认 0.5） */
    keepRatio?: number;
    /** 摘要器；缺失时走确定性降级 */
    summarize?: SubAgentSummaryFn;
    /** token 估算注入（测试用；默认内置轻量估算） */
    estimate?: (message: RequestMessage) => number;
}

export type SubAgentCompressMode = 'none' | 'disabled' | 'summary' | 'fallback' | 'truncate';

export interface SubAgentCompressResult {
    compressed: boolean;
    mode: SubAgentCompressMode;
    beforeTokens: number;
    afterTokens: number;
    /** 被压缩（或降级省略）的消息条数 */
    droppedMessages: number;
    /** 摘要/降级说明（诊断用，不发给模型） */
    diagnostic?: string;
}

/** system 里由本模块注入的段落标记（重复压缩时先剥离，避免摘要层层堆叠）；文案在 utils/protocol */
const SUMMARY_HEADER = SUBAGENT_SUMMARY_HEADER;
const OMIT_HEADER = SUBAGENT_OMIT_HEADER;
const SUMMARY_INPUT_LIMIT = 24000;
const SUMMARY_MESSAGE_LIMIT = 4000;
const DEFAULT_KEEP_RATIO = 0.5;

// ---------------- 轻量 token 估算 ----------------

const isCjk = (cp: number): boolean =>
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2fa1f);

/** 与主链 estimateTextTokens 同口径的轻量近似（不 import utils/message，保持本模块可独立单测） */
export function estimateSubAgentTextTokens(text: unknown): number {
    const source = String(text ?? '');
    if (!source) return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of source) {
        const cp = ch.codePointAt(0) as number;
        if (isCjk(cp)) cjk++;
        else if (cp > 0xffff) other += 2;
        else other++;
    }
    return cjk + Math.ceil(other / 4);
}

/** 单条请求消息的 token 估算（含结构开销、tool_calls、思维链） */
export function estimateSubAgentMessageTokens(message: RequestMessage): number {
    if (!message || typeof message !== 'object') return 0;
    let tokens = 4;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') tokens += estimateSubAgentTextTokens(content);
    else if (Array.isArray(content)) {
        tokens += content.reduce((sum: number, part: unknown) => {
            const p = part as { type?: string; text?: string };
            return sum + (p && p.type === 'text' ? estimateSubAgentTextTokens(p.text) : 8);
        }, 0);
    }
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        tokens += estimateSubAgentTextTokens(JSON.stringify(toolCalls)) + 6;
    }
    const reasoning = (message as { reasoning_content?: unknown }).reasoning_content;
    if (typeof reasoning === 'string') tokens += estimateSubAgentTextTokens(reasoning) + 2;
    if (message.role === 'tool') tokens += 3;
    return tokens;
}

// ---------------- 纯工具函数 ----------------

function isSystem(message: RequestMessage | undefined): boolean {
    return !!message && message.role === 'system';
}

function leadingSystemCount(messages: RequestMessage[]): number {
    let i = 0;
    while (i < messages.length && isSystem(messages[i])) i++;
    return i;
}

/** 折叠空白，便于摘要输入 */
function squash(text: unknown, limit = SUMMARY_MESSAGE_LIMIT): string {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 把一组消息渲染成摘要器输入（有界：单条截断 + 总量截断，确定性） */
export function renderMessagesForSummary(messages: RequestMessage[]): string {
    const lines: string[] = [];
    let used = 0;
    for (const message of messages) {
        if (!message) continue;
        let line: string;
        if (message.role === 'tool') {
            line = `[tool result] ${squash((message as { content?: unknown }).content)}`;
        } else if (message.role === 'assistant' && Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)) {
            const calls = (message as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls || [];
            const describe = calls.map(c => `${c.function?.name ?? 'tool'}(${squash(c.function?.arguments, 300)})`).join('; ');
            const content = squash((message as { content?: unknown }).content, 600);
            line = `[assistant] ${content}${content ? ' ' : ''}[tool calls] ${describe}`;
        } else {
            line = `[${message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system'}] ${squash((message as { content?: unknown }).content)}`;
        }
        if (used + line.length > SUMMARY_INPUT_LIMIT) {
            lines.push('… (earlier content exceeded the summary input limit; truncated)');
            break;
        }
        lines.push(line);
        used += line.length;
    }
    return lines.join('\n');
}

/** 去掉 system 里本模块注入的摘要/省略段（保留原始 system 提示词） */
export function stripInjectedContextSections(systemText: string): string {
    let text = String(systemText ?? '');
    let prev = '';
    while (prev !== text) {
        prev = text;
        text = text
            .replace(new RegExp(`\\n*${escapeRegExp(SUMMARY_HEADER)}[\\s\\S]*$`), '')
            .replace(new RegExp(`\\n*${escapeRegExp(OMIT_HEADER)}[^\\n]*$`), '');
    }
    return text.trim();
}

/** 取出已有摘要正文（重复压缩时滚动合并） */
export function extractInjectedSummary(systemText: string): string {
    const index = String(systemText ?? '').indexOf(SUMMARY_HEADER);
    if (index < 0) return '';
    return String(systemText).slice(index + SUMMARY_HEADER.length).trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 请求消息里的可见文本（截断兜底用） */
function contentOf(message: RequestMessage): string {
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
}

function withContent(message: RequestMessage, content: string): RequestMessage {
    return { ...message, content } as RequestMessage;
}

/** 中段截断：留头 2/3 + 尾 1/3（确定性规则，与主链口径一致） */
export function truncateSubAgentContent(text: string, maxChars: number): string {
    if (maxChars <= 0 || text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 2 / 3);
    const tail = maxChars - head;
    const marker = '\n' + SUBAGENT_TRUNCATE_MARK;
    return `${text.slice(0, Math.max(0, head - marker.length))}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

// ---------------- 独立上下文 ----------------

export class SubAgentContext {
    private messages: RequestMessage[] = [];
    private readonly maxTokens: number;
    private readonly keepRatio: number;
    private readonly summarize?: SubAgentSummaryFn;
    private readonly estimate: (message: RequestMessage) => number;

    constructor(init: SubAgentContextInit) {
        this.maxTokens = Number.isFinite(init.maxTokens) ? Math.floor(init.maxTokens) : 0;
        this.keepRatio = Math.min(0.9, Math.max(0.1, init.keepRatio ?? DEFAULT_KEEP_RATIO));
        this.summarize = init.summarize;
        this.estimate = init.estimate ?? estimateSubAgentMessageTokens;
        const task = String(init.task ?? '');
        const base = init.baseMessages;
        if (Array.isArray(base) && base.length > 0) {
            // 续跑：checkpoint 原样回放（可能已是压缩后的形态），仅追加本轮新任务
            this.messages = base.map(m => ({ ...m }));
            if (task !== '') this.messages.push({ role: 'user', content: task });
            return;
        }
        this.messages = [{ role: 'system', content: String(init.systemText ?? '') }];
        if (Array.isArray(init.seed) && init.seed.length > 0) this.messages.push(...init.seed.map(m => ({ ...m })));
        if (task !== '') this.messages.push({ role: 'user', content: task });
    }

    /** 当前消息快照（浅拷贝数组；消息对象由 append 独占写入） */
    snapshot(): RequestMessage[] {
        return this.messages.slice();
    }

    /** 追加消息（保持调用顺序；工具组由调用方成对追加） */
    append(...messages: RequestMessage[]): void {
        for (const message of messages) {
            if (message) this.messages.push(message);
        }
    }

    /** 当前 token 估算 */
    tokenCount(): number {
        return this.messages.reduce((sum, message) => sum + this.estimate(message), 0);
    }

    messageCount(): number {
        return this.messages.length;
    }

    // ---- 压缩 ----

    /**
     * 超过上限时压缩一次：
     * 1) 选一个合法切点（不拆工具组），把更早的消息交给摘要器；
     * 2) 摘要在 system 里滚动合并（替换旧摘要），最近内容原样保留；
     * 3) 摘要器缺失/失败 → 确定性降级（省略标记 + 必要时继续丢弃/截断最新单元）。
     */
    async maybeCompress(): Promise<SubAgentCompressResult> {
        const before = this.tokenCount();
        if (this.maxTokens <= 0) {
            return { compressed: false, mode: 'disabled', beforeTokens: before, afterTokens: before, droppedMessages: 0 };
        }
        if (before <= this.maxTokens) {
            return { compressed: false, mode: 'none', beforeTokens: before, afterTokens: before, droppedMessages: 0 };
        }

        const systemCount = leadingSystemCount(this.messages);
        const keepBudget = Math.max(1, Math.floor(this.maxTokens * this.keepRatio));
        const cut = this.findCut(systemCount, keepBudget);
        const dropped = this.messages.slice(systemCount, cut);

        if (dropped.length === 0) {
            // 没有可压缩的旧内容（最新单元自身就超预算）：确定性截断最新单元
            const truncated = this.truncateLatestUnit(this.maxTokens);
            const after = this.tokenCount();
            return {
                compressed: truncated,
                mode: truncated ? 'truncate' : 'none',
                beforeTokens: before,
                afterTokens: after,
                droppedMessages: 0,
                ...(truncated ? { diagnostic: 'latest unit alone exceeded the budget; truncated in the middle' } : {}),
            };
        }

        const retained = this.messages.slice(cut);
        let mode: SubAgentCompressMode = 'fallback';
        let diagnostic = '';
        let summaryText = '';
        if (this.summarize) {
            try {
                const previous = extractInjectedSummary(String((this.messages[0] as { content?: unknown }).content ?? ''));
                const input = [previous ? `${EXISTING_SUMMARY_HEADER}\n${previous}` : '', renderMessagesForSummary(dropped)]
                    .filter(Boolean)
                    .join('\n\n');
                const summaryBudget = Math.max(128, Math.floor(this.maxTokens * 0.25));
                const output = await this.summarize(input, { maxTokens: summaryBudget });
                summaryText = String(output ?? '').trim();
                if (summaryText !== '') mode = 'summary';
                else diagnostic = 'summarizer returned empty';
            } catch (e) {
                diagnostic = e instanceof Error ? e.message : String(e);
            }
        } else {
            diagnostic = 'no summarizer configured';
        }

        const baseSystem = this.systemTextWithoutInjected();
        let systemText: string;
        if (mode === 'summary') {
            const summaryBudgetTokens = Math.max(128, Math.floor(this.maxTokens * 0.25));
            const maxChars = Math.max(200, summaryBudgetTokens * 2);
            const bounded = summaryText.length > maxChars ? truncateSubAgentContent(summaryText, maxChars) : summaryText;
            systemText = `${baseSystem}\n\n${SUMMARY_HEADER}\n${bounded}`;
        } else {
            systemText = `${baseSystem}\n\n${subagentOmitLine(dropped.length)}`;
        }
        this.messages = [{ role: 'system', content: systemText }, ...retained];

        // 降级/摘要后仍超预算：继续按"不拆工具组"丢弃较旧单元，最后才截断最新单元
        if (this.tokenCount() > this.maxTokens) this.dropUntilWithinBudget();
        if (this.tokenCount() > this.maxTokens) this.truncateLatestUnit(this.maxTokens);

        const after = this.tokenCount();
        return {
            compressed: true,
            mode,
            beforeTokens: before,
            afterTokens: after,
            droppedMessages: dropped.length,
            ...(diagnostic ? { diagnostic } : {}),
        };
    }

    /** system 原文（剥离本模块注入的段落） */
    private systemTextWithoutInjected(): string {
        const first = this.messages[0];
        const text = first && first.role === 'system' ? String((first as { content?: unknown }).content ?? '') : '';
        return stripInjectedContextSections(text);
    }

    /** 从 systemCount 起找"保留后缀 <= keepBudget"且不拆工具组的最小下标 */
    private findCut(systemCount: number, keepBudget: number): number {
        const total = this.messages.reduce((sum, m) => sum + this.estimate(m), 0);
        const systemTokens = this.messages.slice(0, systemCount).reduce((sum, m) => sum + this.estimate(m), 0);
        let suffixTokens = total - systemTokens;
        let best = -1;
        for (let cut = systemCount; cut < this.messages.length; cut++) {
            if (this.isValidCut(cut)) {
                best = cut;
                if (suffixTokens <= keepBudget) return cut;
            }
            suffixTokens -= this.estimate(this.messages[cut]);
        }
        // 没有满足预算的合法切点：退化为"能保留的最短合法后缀"（留给后续兜底继续丢弃）
        return best >= 0 ? best : this.messages.length;
    }

    /** 切点合法：后缀不能以 tool 结果开头（否则工具调用组被拆） */
    private isValidCut(cut: number): boolean {
        const message = this.messages[cut];
        if (!message) return false;
        return message.role !== 'tool';
    }

    /** 降级兜底：按消息个数从旧到新继续丢弃，但仍保证不拆工具组 */
    private dropUntilWithinBudget(): void {
        const systemCount = leadingSystemCount(this.messages);
        while (this.tokenCount() > this.maxTokens) {
            const cut = this.findCut(systemCount, 0);
            if (cut <= systemCount || cut >= this.messages.length) break;
            this.messages.splice(systemCount, cut - systemCount);
        }
    }

    /**
     * 最新单元自身超预算：确定性中段截断（只缩文本，不动 tool_calls/配对）。
     * 最新单元 = 末尾连续 tool 结果 + 其 assistant(tool_calls) owner；否则就是最后一条消息。
     */
    private truncateLatestUnit(maxTokens: number): boolean {
        if (this.messages.length === 0) return false;
        let unitStart = this.messages.length - 1;
        while (unitStart > 0 && this.messages[unitStart].role === 'tool') unitStart--;
        if (this.messages[unitStart].role !== 'tool' && unitStart > 0) {
            // 若 latest 是 assistant(tool_calls) 且其后没有 tool 结果，保持自身即可
            const own = unitStart;
            const prev = this.messages[own - 1];
            if (own > 0 && prev && prev.role === 'assistant') unitStart = own;
        }
        if (unitStart < leadingSystemCount(this.messages)) unitStart = leadingSystemCount(this.messages);
        let changed = false;
        const maxRounds = 16;
        for (let round = 0; round < maxRounds && this.tokenCount() > maxTokens; round++) {
            let biggestIndex = -1;
            let biggestLength = 0;
            for (let i = unitStart; i < this.messages.length; i++) {
                const text = contentOf(this.messages[i]);
                if (text.length > biggestLength) {
                    biggestLength = text.length;
                    biggestIndex = i;
                }
            }
            if (biggestIndex < 0 || biggestLength <= 16) break;
            const excess = this.tokenCount() - maxTokens;
            const target = Math.max(128, biggestLength - Math.max(64, excess * 2));
            this.messages[biggestIndex] = withContent(this.messages[biggestIndex], truncateSubAgentContent(contentOf(this.messages[biggestIndex]), target));
            changed = true;
        }
        return changed;
    }
}
