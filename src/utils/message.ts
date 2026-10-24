// 消息构建：system prompt 组装与 body 解析
import Config from "../config/config";
import type { ConversationEvent } from "../context/events";
import type { CompiledMessage } from "../context/view/compile";
import { logger } from "../logger";
import { resolveEffectiveMaxTokens } from "../model/api_error";
import { getProbedContextWindow } from "../model/window_cache";
import { buildSystemPromptContent } from "../prompt/builder";
import Image from "../resource/image";
import { Session } from "../session/session";
import User from "../session/user";
import { TokenCalibration } from "../token_calibration";
import { ToolCall, ToolContentPart } from "../tool/types";

import { compareRequests, formatRequestShadowReport, isRequestShadowEnabled, isRequestV2Enabled, recordRequestShadowReport } from "./request_shadow";
import { escapeToolResultBoundary, fmtDate } from "./string";
import { withTimeout } from "./timeout";

/** OpenAI 兼容内容：纯文本，或多模态内容块（文本 + 图片） */
export type RequestMessageContent =
    | string
    | Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }>;

export interface RequestMessage {
    role: string;
    content: RequestMessageContent;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
}

/** 多模态请求构建选项：imagesAsText=本轮把 URL 型图片降级为文本标签（模型报「图片下载失败」后重发用） */
export interface MultimodalBuildOptions {
    imagesAsText?: boolean;
    /** 本次请求实际使用的模型（用于判断模型端点是否可达图床公网/内网地址） */
    model?: { baseUrl?: string };
}

interface MessageItem {
    text: string;
    time: number;
    userId?: string;
    messageId?: string;
    systemName?: string;
    reasoningContent?: string;
}

interface ContextMessage {
    role: string;
    contentItems?: MessageItem[];
    text?: string;
    contentParts?: ToolContentPart[];
    toolName?: string; // 工具名：prompt 工程模式下把工具结果转回 user 消息时保留来源
    toolCalls?: ToolCall[];
    tool_calls?: ToolCall[];
    toolCallId?: string;
    tool_call_id?: string;
    reasoningContent?: string;
}

const SYSTEM_REMINDER_TEXT = '请继续遵守上方角色设定、上下文标记和工具调用规范。';

/**
 * 无依赖的 token 估算：按 Unicode 类别分桶近似 BPE。
 * 用于「上下文最大token」的整包预算估算，避免依赖外部 tokenizer。
 */
export function estimateTextTokens(text: string): number {
    let asciiAlnum = 0;
    let asciiSpace = 0;
    let asciiPunct = 0;
    let cjk = 0;
    let cjkLike = 0;
    let otherBmp = 0;
    let astral = 0;

    for (const ch of String(text || '')) {
        const cp = ch.codePointAt(0) as number;
        if (isCjkCodePoint(cp)) {
            cjk++;
        } else if (cp > 0xFFFF) {
            astral++;
        } else if (cp <= 0x7F) {
            if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) {
                asciiAlnum++;
            } else if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0D)) {
                asciiSpace++;
            } else if (cp >= 0x21 && cp <= 0x7E) {
                asciiPunct++;
            } else {
                asciiSpace++;
            }
        } else if (isCjkLikeCodePoint(cp)) {
            cjkLike++;
        } else {
            otherBmp++;
        }
    }

    return Math.ceil(asciiAlnum / 4)
        + Math.ceil(asciiSpace / 4)
        + Math.ceil(asciiPunct / 2)
        + cjk
        + Math.ceil(cjkLike * 3 / 2)
        + Math.ceil(otherBmp / 2)
        + astral * 2;
}

function isCjkCodePoint(cp: number): boolean {
    return (cp >= 0x3400 && cp <= 0x4DBF)
        || (cp >= 0x4E00 && cp <= 0x9FFF)
        || (cp >= 0xF900 && cp <= 0xFAFF)
        || (cp >= 0x20000 && cp <= 0x2FA1F);
}

function isCjkLikeCodePoint(cp: number): boolean {
    return (cp >= 0x3040 && cp <= 0x30FF)
        || (cp >= 0xAC00 && cp <= 0xD7AF);
}

/** 请求体结构 overhead 默认值 */
const MESSAGE_BASE_OVERHEAD = 4;
const TOOL_CALL_OVERHEAD = 6;
const TOOL_RESULT_OVERHEAD = 3;
const REASONING_FIELD_OVERHEAD = 2;

/**
 * 单条消息 token 估算：与 estimateTextTokens 同一口径，额外计入请求 JSON 结构开销。
 * 兼容 RequestMessage（content 为字符串或多模态内容块）与 ContextMessage（contentItems/text），
 * 并把 assistant 的 tool_calls JSON、reasoning_content/思维链一并计入，
 * 使「上下文最大token」与请求体真实负载一致。
 * applyTokenBudget 与 stream.checkRequestBudget 统一使用该口径，避免两套估算不一致。
 * 多模态图片 URL/base64 只按固定 [image] 开销估算，避免把 base64 当纯文本猛算。
 */
export function estimateMessageTokens(m: ContextMessage | RequestMessage): number {
    let text = '';
    const content = (m as RequestMessage).content;
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        text = content.map(part => part.type === 'text' ? part.text : '[image]').join('');
    } else {
        const contextMessage = m as ContextMessage;
        if (Array.isArray(contextMessage.contentParts) && contextMessage.contentParts.length > 0) {
            text = contextMessage.contentParts
                .map(part => part.type === 'text' ? part.text : '[image]')
                .join('');
        } else {
            text = buildContent(contextMessage);
        }
    }

    const toolCalls = (m as ContextMessage).toolCalls || (m as RequestMessage).tool_calls;
    const toolCallsEst = Array.isArray(toolCalls) && toolCalls.length > 0
        ? estimateTextTokens(JSON.stringify(toolCalls))
        : 0;

    const requestReasoning = (m as RequestMessage).reasoning_content;
    const reasoningText = requestReasoning !== undefined
        ? requestReasoning
        : resolveReasoningContent(m as ContextMessage);
    const reasoningTokens = reasoningText !== undefined
        ? estimateTextTokens(reasoningText) + REASONING_FIELD_OVERHEAD
        : 0;

    let tokens = estimateTextTokens(text) + toolCallsEst + MESSAGE_BASE_OVERHEAD + reasoningTokens;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) tokens += TOOL_CALL_OVERHEAD;
    if (m.role === 'tool') tokens += TOOL_RESULT_OVERHEAD;
    return tokens;
}

/**
 * 取消息携带的思维链：消息级字段（tool_calls 消息）或内容条目级字段（assistant 文本消息）。
 * 空字符串也原样返回（DeepSeek thinking mode 要求字段本身必须回传，不能忽略）。
 */
function resolveReasoningContent(message: ContextMessage): string | undefined {
    if (message.reasoningContent !== undefined) return message.reasoningContent;
    if (Array.isArray(message.contentItems)) {
        const item = message.contentItems.find(i => i && i.reasoningContent !== undefined);
        if (item) return item.reasoningContent;
    }
    return undefined;
}

export async function buildSystemMessage(ctx: seal.MsgContext, session: Session): Promise<ContextMessage> {
    const { roleIndex, roleSetting } = getRoleSetting(ctx);
    const content = await buildSystemPromptContent(ctx, session, roleIndex, roleSetting);

    return {
        role: 'system',
        contentItems: [{
            text: content,
            time: Math.floor(Date.now() / 1000),
            systemName: ''
        }]
    };
}

function buildSamplesMessages(ctx: seal.MsgContext): ContextMessage[] {
    const { SAMPLE_MESSAGES } = Config.context;

    return SAMPLE_MESSAGES
        .map((item, index) => ({ item, index }))
        .filter(x => x.item.trim() !== '')
        .map((x, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            contentItems: [{
                text: x.item,
                time: Math.floor(Date.now() / 1000),
                userId: i % 2 === 0 ? '' : ctx.endPoint.userId
            }]
        }));
}

/**
 * 转热装回档位（纯代码判定，只看本轮最新一条消息的文本；见 docs/03 上下文模块）：
 * - L2：明确要求回顾（总结/回顾/整理一下…）→ 不折叠，交给 token 预算兜底
 * - L1：含指代或追问词（它/这个/刚才/上面/继续…）→ 多装一段
 * - L0：默认 → 只装最近 `冷态窗口字数`
 */
export function pickTier(text: string): 'L0' | 'L1' | 'L2' {
    if (/总结|回顾|整理一下|前面说过|之前说过|汇总/.test(text)) return 'L2';
    if (/它|这个|那个|刚才|上面|继续|为什么|然后呢|结果呢|那呢/.test(text)) return 'L1';
    return 'L0';
}

/** 档位 → 折叠预算字数（0 = 不折叠） */
export function windowCharsForTier(tier: 'L0' | 'L1' | 'L2', baseChars: number): number {
    if (baseChars <= 0) return 0;
    if (tier === 'L2') return 0;
    if (tier === 'L1') return baseChars + 20000;
    return baseChars;
}

/** 折叠行的短摘要（纯代码，零 LLM）：保留发送者/时间与开头若干字 */
function foldLine(item: any, max = 40): string {
    const who = item.userId ? formatFromPrefix(item.userId) : (item.systemName ? `[system:${item.systemName}]` : '');
    const time = item.time ? `[time:${fmtDate(item.time)}]` : '';
    const text = String(item.text || '').replace(/\s+/g, ' ').trim();
    const head = text.length > max ? `${text.slice(0, max)}…` : text;
    return `- ${who}${time} ${head}`;
}

/** 折叠摘要自身占整包预算的比例（保证"窗口 + 摘要"整体不超预算） */
const FOLD_BUDGET_RATIO = 0.4;
const FOLD_MIN_CHARS = 200;

/**
 * 渲染窗口折叠：把超出预算的**更早内容**折叠成一条纯代码摘要（零 LLM），只保留最近一段。
 * - 按条目粒度裁剪（待机群里整段历史是同一条 user 消息，必须能切进 contentItems 内部）；
 * - **`assistant(tool_calls)` + 紧随的 `tool` 结果作为原子组同留同折**：否则可能只折掉 tool_calls
 *   而留下 tool 结果，随后被 handleMessages 的孤儿清理删掉 → 模型静默看不到工具返回；
 * - 折叠摘要本身也受预算限制：从新到旧填充明细行，放不下的只统计条数（否则短消息群里"折叠"反而更长）；
 * - 窗口优先：最新一条（或最新一个原子组）无论多长都保留，因此单条超大时整包可能略超预算。
 * @param budgetChars 整包预算字数；<= 0 表示不折叠
 */
export function foldContextMessages(messages: ContextMessage[], budgetChars: number): ContextMessage[] {
    // 注意：**不在这里做工具配对校验**。本函数也用于"提示词工程"模式，该模式会把 tool 结果
    // 转成 user 文本（见 handleMessages 的 PROMPT_ENGINEERING 分支），此时"没有配对 assistant 的
    // tool 消息"是合法的，删除它会丢工具结果。配对校验只应在**真正发送 role:'tool'** 的路径上做
    // （handleMessages 末尾的非 PE 路径已有对应处理）。
    if (budgetChars <= 0) return messages;
    const total = messages.reduce((n, m) => n + buildContent(m).length, 0);
    if (total <= budgetChars) return messages;

    const foldBudget = Math.max(FOLD_MIN_CHARS, Math.floor(budgetChars * FOLD_BUDGET_RATIO));
    const windowBudget = Math.max(1, budgetChars - foldBudget);

    const kept: ContextMessage[] = [];
    const foldedNewestFirst: string[] = [];
    let used = 0;
    let keptAny = false;

    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'tool') continue;   // 由前面的 assistant(tool_calls) 原子组统一处理

        const toolCalls = (m as any).toolCalls || (m as any).tool_calls;
        if (m.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length > 0) {
            const group: ContextMessage[] = [m];
            for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) group.push(messages[j]);
            const groupLen = group.reduce((n, g) => n + buildContent(g).length, 0);
            if (!keptAny || used + groupLen <= windowBudget) {
                for (let g = group.length - 1; g >= 0; g--) kept.unshift(group[g]);
                used += groupLen;
                keptAny = true;
            } else {
                for (const g of group) foldedNewestFirst.push(foldLine(g));   // 整组一起折
            }
            continue;
        }

        const items = Array.isArray(m.contentItems) ? m.contentItems : null;
        if (items && items.length > 0) {
            const keptItems: any[] = [];
            for (let j = items.length - 1; j >= 0; j--) {
                const one = { ...m, contentItems: [items[j]] } as ContextMessage;
                const len = buildContent(one).length;
                // 最新的一条无论多长都保留（否则窗口会空）
                if (!keptAny || used + len <= windowBudget) {
                    keptItems.unshift(items[j]);
                    used += len;
                    keptAny = true;
                } else {
                    foldedNewestFirst.push(foldLine(items[j]));
                }
            }
            if (keptItems.length > 0) kept.unshift({ ...m, contentItems: keptItems });
        } else {
            const len = buildContent(m).length;
            if (!keptAny || used + len <= windowBudget) {
                kept.unshift(m);
                used += len;
                keptAny = true;
            } else {
                foldedNewestFirst.push(foldLine(m));
            }
        }
    }

    // 配对（tool_call_id ↔ tool_calls[].id）由**下方过滤循环**保证：无配对的 tool 会被剔、
    // 无结果的 tool_calls 会被过滤，全过滤时同步删除其后跟随的 tool 消息。
    // 这里**刻意不额外做一遍剔除**：本函数也服务 PE 模式（tool 结果转 user 文本，无配对是合法的），
    // 在那条路径上删 tool 会丢工具结果。详见 handleMessages 的非 PE 分支。
    if (foldedNewestFirst.length === 0) return kept;
    const header = `更早的群聊/工具内容已折叠为摘要（共 ${foldedNewestFirst.length} 条；需要原文时用 read_raw / grep_raw 回查）：`;
    const detail: string[] = [];
    let foldUsed = header.length + 1;
    let omitted = 0;
    for (const line of foldedNewestFirst) {   // 从新到旧填充，优先保留较近的折叠明细
        if (foldUsed + line.length + 1 <= foldBudget) {
            detail.push(line);
            foldUsed += line.length + 1;
        } else {
            omitted++;
        }
    }
    const aggLine = omitted > 0 ? `- 更早的 ${omitted} 条已省略（同上，按需回查原文）` : '';
    const foldText = [header, aggLine, ...detail.reverse()].filter(Boolean).join('\n');

    const foldItem = {
        text: foldText,
        time: Math.floor(Date.now() / 1000),
        systemName: '折叠摘要',
    };
    const first = kept[0];
    if (first && first.role === 'user' && Array.isArray(first.contentItems)) first.contentItems.unshift(foldItem);
    else kept.unshift({ role: 'user', contentItems: [foldItem] });
    return kept;
}

/**
 * 取工具结果消息引用的 tool_call id。
 * **必须同时认 `toolCallId` 与 `tool_call_id`**：上下文内的 `ToolCallbackMessage` 用 camelCase
 * `toolCallId`（src/context/types.ts:62），而 `tool_call_id` 只出现在**出站请求体**（RequestMessage）。
 * 只认其中一个会把合法工具结果误判为孤儿——这个坑在实现窗口移出的配对校验时真实踩到过
 * （多模态工具结果被误删，testToolMultimodalContentParts 报错）。
 */
export function toolResultCallId(m: any): string {
    const id = m?.toolCallId ?? m?.tool_call_id;
    return id === undefined || id === null || id === '' ? '' : String(id);
}

/**
 * 渲染折叠预算（字数；0 = 不折叠）：
 * - **只有待机会话**（会话待机或全局待机）才折叠——这是"冷态窗口"的用途；正常对话模式渲染全文，交给 token 预算；
 * - 档位按本轮最新一条 user 条目判定（L0 默认 / L1 含指代 / L2 明确要求回顾不折叠）。
 */
export function renderFoldBudget(session: Session, messages: ContextMessage[]): number {
    const standby = session.setting?.standby === true || Config.base.GLOBAL_STANDBY === true;
    if (!standby) return 0;
    // 按会话覆盖优先（P2-1）：本会话设了「冷态窗口字数」就用它，否则用全局配置
    const base = session.setting?.overrideOr?.('coldWindowChars', Config.context.COLD_WINDOW_CHARS)
        ?? Config.context.COLD_WINDOW_CHARS;
    if (base <= 0) return 0;
    // 档位只看"最新一条**真实用户发言**"：跳过系统条目（事件/触发提示/折叠摘要本身），
    // 否则"继续""总结"这类系统文案会把档位带偏（例如续跑提示含"继续"→ 误升 L1）。
    let newestText = '';
    for (let i = messages.length - 1; i >= 0 && !newestText; i--) {
        const m = messages[i];
        if (m.role !== 'user' || !Array.isArray(m.contentItems)) continue;
        for (let j = m.contentItems.length - 1; j >= 0; j--) {
            const it = m.contentItems[j] as any;
            if (it && typeof it.text === 'string' && it.userId) {
                newestText = it.text;
                break;
            }
        }
    }
    return windowCharsForTier(pickTier(newestText), base);
}

/**
 * 给**辅助请求**（打分 judge 等）用的"窗口化历史"：与主对话复用同一套折叠规则，
 * 保证辅助请求的单次 prompt 体积也有上界（P1-1）。
 *
 * 为什么需要：`JudgeManager.buildHistory` 原按"最近 N **条消息**"整条渲染，而待机群里所有
 * 群聊消息都追加进**同一条** user 消息 → "最近 10 条消息"实际就是那一条 → 打分 prompt
 * 可能包含整个待机块（几万字）。gate 只限调用**次数**，不限单次**体积**。
 *
 * 预算取 `renderFoldBudget`（非待机会话为 0＝不折叠）；为 0 时退化为「冷态窗口字数」，
 * 仍为 0 时用内置常量兜底。**无论折叠是否生效都有 head 硬截断兜底**。
 *
 * @param maxCharsOverride 显式预算；不传则自动按会话推导
 */
export const AUX_HISTORY_FALLBACK_CHARS = 5000;
export const AUX_HISTORY_OMIT_MARK = '…（更早内容已省略）';

export function renderWindowedHistory(
    session: Session,
    messages: ContextMessage[],
    maxCharsOverride?: number,
): string {
    let budget = maxCharsOverride;
    if (budget === undefined) {
        budget = renderFoldBudget(session, messages);
        if (budget <= 0) {
            const base = Config.context.COLD_WINDOW_CHARS;
            budget = base > 0 ? base : AUX_HISTORY_FALLBACK_CHARS;
        }
    }
    const folded = budget > 0 ? foldContextMessages(messages.slice(), budget) : messages.slice();

    const lines: string[] = [];
    for (const m of folded) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const text = buildContent(m).replace(/\f/g, '\n').trim();
        if (!text) continue;
        lines.push(`${m.role === 'assistant' ? '[bot]' : '[用户]'} ${text}`);
    }

    let out = lines.join('\n');
    // 兜底硬截断：折叠也放不下时（如单条超大且被"窗口优先"保留）仍保证有上界
    if (budget > 0 && out.length > budget) {
        out = out.slice(0, Math.max(0, budget - AUX_HISTORY_OMIT_MARK.length)) + AUX_HISTORY_OMIT_MARK;
    }
    return out;
}

function buildContextMessages(messages: ContextMessage[], foldBudget: number): ContextMessage[] {
    const { INSERT_COUNT } = Config.context;

    const contextMessages = foldContextMessages(messages.slice(), foldBudget);
    if (INSERT_COUNT <= 0) return contextMessages;

    // 顺序遍历：在第 INSERT_COUNT+1 条及之后每隔 INSERT_COUNT 条用户消息前插入短提醒，
    // 避免把完整角色设定、资源说明和工具说明按轮数反复复制进上下文。
    let userCount = 0;
    const result: ContextMessage[] = [];
    for (const m of contextMessages) {
        if (m.role === 'user' && userCount > 0 && userCount % INSERT_COUNT === 0) {
            result.push({ role: 'system', text: SYSTEM_REMINDER_TEXT });
        }
        result.push(m);
        if (m.role === 'user') userCount++;
    }
    return result;
}

/**
 * 请求组装前克隆上下文消息，避免 token 裁剪/tool_calls 过滤污染持久化会话数据。
 */
function cloneContextMessage(message: ContextMessage): ContextMessage {
    const clone: ContextMessage = { ...message };

    if (Array.isArray(message.contentItems)) {
        clone.contentItems = message.contentItems.map(item => ({ ...item }));
    }

    if (Array.isArray(message.toolCalls)) {
        clone.toolCalls = message.toolCalls.map(tc => ({
            ...tc,
            function: tc.function ? { ...tc.function } : tc.function
        }));
    }

    if (Array.isArray(message.tool_calls)) {
        clone.tool_calls = message.tool_calls.map(tc => ({
            ...tc,
            function: tc.function ? { ...tc.function } : tc.function
        }));
    }

    return clone;
}


/**
 * 紧急兜底截断：把单条消息的渲染文本裁剪到 maxChars（保留尾部最近内容），返回实际移除的字符数。
 * 仅用于预算兜底（如单条超大消息/合并转发/工具长结果），结构上简化为单段文本，不动 tool_calls。
 */
function truncateMessageText(message: ContextMessage, maxChars: number): number {
    const before = buildContent(message);
    if (before.length <= maxChars) return 0;
    // 截断会清空 contentItems，先把思维链提升到消息级，避免后续请求丢失 reasoning_content
    const reasoning = resolveReasoningContent(message);
    message.contentItems = undefined;
    message.text = before.slice(-maxChars);
    if (reasoning !== undefined) message.reasoningContent = reasoning;
    return before.length - message.text.length;
}

/**
 * token 预算裁剪：在 system + samples + context 完整组装后统一计算，超出预算时从最早的
 * context 消息开始丢弃；system 与 samples 永不丢弃。tools 的 JSON 长度同样预留进预算，
 * 使「上下文最大token」更接近真实请求体上限。
 *
 * 单条超大消息兜底：当某条未保护消息本身超过当前缺口（典型为合并转发/工具长结果等
 * 单条消息过大，整条丢弃会清空全部上下文）时，改为按超出量截断其渲染文本（保留尾部），
 * 而不是让请求体带着超限预算直接发送，也不会把整个会话上下文一次性清空。
 */
function applyTokenBudget(messages: ContextMessage[], protectedCount: number, tools?: unknown[], modelName?: string): ContextMessage[] {
    const { MAX_CONTEXT_TOKENS: configuredTokens } = Config.context;
    // P2-3：配置为 0 时跟随"报错探测到的模型真实窗口"（按模型名持久化缓存）。
    // 这里而不是 Config.context 里解析，是因为需要 modelName，且 Config 的组级 getter 有 60s 缓存、不带模型维度。
    const { tokens: maxTokens } = resolveEffectiveMaxTokens(configuredTokens, getProbedContextWindow(modelName || ''));
    if (maxTokens <= 0) return messages;

    const reserve = tools && tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;
    const factor = TokenCalibration.getFactor(modelName || '');
    const budget = factor > 0
        ? Math.max(Math.floor(maxTokens / factor - reserve), 1)
        : Math.max(maxTokens - reserve, 1);
    const totalTokens = () => messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    let tokens = totalTokens();

    while (tokens > budget && messages.length > protectedCount) {
        // 常规情况：整条丢弃最早的未保护消息（system/samples 受保护，永不丢弃）
        if (messages.length - protectedCount > 1) {
            tokens -= estimateMessageTokens(messages[protectedCount]);
            messages.splice(protectedCount, 1);
            continue;
        }

        // 兜底：只剩一条未保护消息仍超预算时，截断其渲染文本保留尾部，
        // 而不是整条丢弃清空用户上下文（典型为合并转发/工具长结果等超大单条）
        const over = tokens - budget;
        const last = messages[protectedCount];
        const len = buildContent(last).length;
        const est = estimateMessageTokens(last);
        if (len <= 0 || est <= 0) break;
        const prev = tokens;
        // 按超出量折算需移除的字符数（每 token 约等于该消息的字符/token 比值）
        const charsToRemove = Math.max(1, Math.ceil(len * (over / est)));
        truncateMessageText(last, Math.max(1, len - charsToRemove));
        tokens = totalTokens();
        // 截断未降低估算（如超出量主要来自 tool_calls）时停止，避免死循环
        if (tokens >= prev) break;
    }
    return messages;
}

/** 影子：把旧请求体与 v2 compileRequest 做只读对比；开启 v2 返回时返回 compile 结果 */
function maybeShadowCompiledRequest(
    session: Session,
    system: ContextMessage,
    samples: ContextMessage[],
    legacy: RequestMessage[],
    multimodal: boolean,
    tools: unknown[] | undefined,
    modelName: string | undefined,
): CompiledMessage[] | null {
    const shadow = isRequestShadowEnabled();
    const serveV2 = isRequestV2Enabled() || !!session.contextV2;
    if ((!shadow && !serveV2) || !session.contextV2) return null;
    try {
        const prefix: CompiledMessage[] = [system, ...samples].map(message => ({
            role: message.role as CompiledMessage['role'],
            content: buildContent(message),
        }));
        const configured = Config.context.BUDGET_TOKENS;
        const overrideBudget = (session.setting as { overrides?: Record<string, unknown> } | undefined)?.overrides?.ctxBudgetTokens;
        const baseBudget = typeof overrideBudget === 'number' && overrideBudget > 0 ? overrideBudget : configured;
        const { tokens: budget } = resolveEffectiveMaxTokens(baseBudget, getProbedContextWindow(modelName || ''));
        const compiled = session.contextV2.compile({
            prefixMessages: prefix,
            budgetTokens: budget,
            toolsReserveTokens: Array.isArray(tools) ? tools.length * 20 : 0,
            mode: Config.tool.PROMPT_ENGINEERING ? 'prompt-engineering' : 'native',
            caps: { vision: multimodal },
            resolve: {
                imageUrl: (ref: string) => {
                    try {
                        const image = Image.resolveRef(ref);
                        if (!image || image.isUrlUnusable()) return null;
                        return image.src || null;
                    } catch {
                        return null;
                    }
                },
                avatarUrl: (uid: string) => {
                    try {
                        return Image.resolveRef(`user_avatar:${uid}`)?.src || null;
                    } catch {
                        return null;
                    }
                },
                groupAvatarUrl: (gid: string) => {
                    try {
                        return Image.resolveRef(`group_avatar:${gid}`)?.src || null;
                    } catch {
                        return null;
                    }
                },
            },
            resolveUserName: (uid: string) => {
                const number = uid.replace(/^.+:/, '');
                try {
                    const name = User.get(uid).userName;
                    return name ? `${name}(${number})` : number;
                } catch {
                    return number;
                }
            },
            formatTime: fmtDate,
            formatMessageId: (id: string) => id,
            estimateTextTokens,
            estimateEventTokens: (event: ConversationEvent) => {
                const parts = (event as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
                let chars = 0;
                for (const part of parts) if (part.type === 'text') chars += String(part.text ?? '').length;
                if (event.kind === 'tool_call') chars += String(event.args ?? '').length;
                return Math.max(1, Math.ceil(chars / 3)) + 4;
            },
        });
        const report = compareRequests(legacy, compiled.messages);
        recordRequestShadowReport(report);
        if (report.equal) {
            logger.info('[context-v2] 请求影子一致');
        } else {
            logger.warning('[context-v2] 请求影子差异：' + formatRequestShadowReport(report).slice(0, 3000));
        }
        return serveV2 ? compiled.messages : null;
    } catch (error) {
        logger.warning('[context-v2] 请求影子构建失败: ' + (error instanceof Error ? error.message : String(error)));
        return null;
    }
}

export async function handleMessages(
    ctx: seal.MsgContext,
    session: Session,
    multimodal = false,
    tools?: unknown[],
    systemMessage?: ContextMessage,
    modelName?: string,
    opts?: MultimodalBuildOptions
): Promise<RequestMessage[]> {
    const system = systemMessage ?? await buildSystemMessage(ctx, session);
    const samplesMessages = buildSamplesMessages(ctx);
    const clonedContext = (session.context.messages as ContextMessage[]).map(cloneContextMessage);
    const contextMessages = buildContextMessages(clonedContext, renderFoldBudget(session, clonedContext));

    const messages: ContextMessage[] = applyTokenBudget(
        [system, ...samplesMessages, ...contextMessages],
        samplesMessages.length + 1,
        tools,
        modelName
    );

    // 提示词工程模式：不向 API 发送 role:'tool'，也不带 assistant tool_calls；
    // 工具结果转成 user 文本（带【工具返回】标记），保证模型能看到结果而不会反复调用工具
    if (Config.tool.PROMPT_ENGINEERING) {
        const peMessages = await Promise.all(messages.map(async message => {
            if (message.role === 'tool') {
                // 保留工具名来源，便于模型区分不同工具的返回；旧上下文无 toolName 时退化为通用标记
                const toolName = (message as ContextMessage).toolName;
                const prefix = toolName ? `【工具返回:${toolName}】` : `【工具返回】`;
                // PE 模式下工具结果是 user 文本；若工具返回了图片内容块（image_view / MCP image），
                // 必须把 image_url 一起带上，否则多模态模型看不到图
                const imageParts = multimodal && Array.isArray(message.contentParts)
                    ? message.contentParts.filter(p => p && p.type === 'image_url')
                    : [];
                if (imageParts.length > 0) {
                    return {
                        role: 'user',
                        content: [
                            { type: 'text' as const, text: prefix + buildContent(message) },
                            ...imageParts,
                        ],
                    };
                }
                return { role: 'user', content: prefix + buildContent(message) };
            }
            const out: RequestMessage = {
                role: message.role,
                content: multimodal ? await buildMultimodalContent(message, opts) : buildContent(message)
            };
            const reasoning = resolveReasoningContent(message);
            if (reasoning !== undefined) out.reasoning_content = reasoning;
            return out;
        }));
        const served = maybeShadowCompiledRequest(session, system, samplesMessages, peMessages, multimodal, tools, modelName);
        return (served ?? peMessages) as RequestMessage[];
    }

    // 非 PE 路径会真正发送 role:'tool'；配对（tool_call_id ↔ tool_calls[].id）由下面的过滤循环
    // 与 `handleMessages` 既有逻辑保证：无配对 tool 会被剔、无结果的 tool_calls 会被过滤，
    // 且全过滤时同步删除其后跟随的 tool 消息。实测（探针）前导悬空/非连续形态均已被覆盖，
    // 因此这里**不额外加一遍剔除**，避免重复与误删（PE 模式下的合法无配对 tool 更不能删）。
    // 过滤没有对应 tool_call_id 的 tool_calls
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const toolCalls = message.toolCalls || message.tool_calls;
        if (!toolCalls || toolCalls.length === 0) continue;

        const toolCallIdSet = new Set<string>();
        for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role !== 'tool') break;
            toolCallIdSet.add(messages[j].toolCallId || messages[j].tool_call_id || '');
        }

        for (let j = 0; j < toolCalls.length; j++) {
            if (!toolCalls[j].id || !toolCallIdSet.has(toolCalls[j].id)) {
                toolCalls.splice(j, 1);
                j--;
            }
        }

        if (toolCalls.length === 0) {
            // assistant 的 tool_calls 全部被过滤时，同步删除其后跟随的 tool 消息，避免孤立
            for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
                messages.splice(j, 1);
                j--;
            }
            messages.splice(i, 1);
            i--;
        }
    }

    // 清理孤立/失配的 tool 消息，避免发给 API 时出现
    // "role 'tool' 必须跟在对应 tool_calls 之后" 报错（如上下文被裁剪后残留）。
    //
    // **两层判据**（fuzz 发现第二层原先缺失）：
    //   (1) tool 的 id 在整份消息里找不到对应的 assistant(tool_calls) → 丢弃；
    //   (2) 找到了，但两者**不相邻**（中间夹了别的非 tool 消息）→ 同样丢弃。
    //       OpenAI 兼容接口要求 tool 结果**紧跟**在发起它的 assistant 之后（中间只能有其他 tool），
    //       仅"存在同 id 的 assistant"并不够 —— 例如 [assistant(tc), tool, user, tool] 里
    //       第二个 tool 会被真实接口拒绝。原先只查了 (1)，故此类请求体漏了出去。
    const toolCallIdSet = new Set<string>();
    for (const message of messages) {
        const toolCalls = message.toolCalls || message.tool_calls;
        if (message.role === 'assistant' && toolCalls) {
            for (const tc of toolCalls) toolCallIdSet.add(tc.id);
        }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'tool') continue;
        const id = message.toolCallId || message.tool_call_id || '';
        if (!toolCallIdSet.has(id)) { messages.splice(i, 1); continue; }
        // (2) 相邻性：向上跳过连续的 tool，必须落到一个"发起了该 id"的 assistant
        let j = i - 1;
        while (j >= 0 && messages[j].role === 'tool') j--;
        const owner = j >= 0 ? messages[j] : null;
        const ownerCalls = owner ? (owner.toolCalls || owner.tool_calls) : null;
        const adjacent = !!owner && owner.role === 'assistant' && Array.isArray(ownerCalls)
            && ownerCalls.some((tc: any) => tc && String(tc.id) === String(id));
        if (!adjacent) messages.splice(i, 1);
    }

    const finalMessages = await Promise.all(messages.map(async message => {
        const out: RequestMessage = {
            role: message.role,
            content: message.role === 'tool'
                ? (multimodal && Array.isArray(message.contentParts) && message.contentParts.length > 0
                    ? message.contentParts
                    : buildContent(message))
                : (multimodal ? await buildMultimodalContent(message, opts) : buildContent(message))
        };
        // 只在 assistant 且 tool_calls 非空时附带该字段：空数组在 JSON 里是合法值，
        // 会被原样序列化为 "tool_calls":[]，部分后端直接报错拒绝请求
        if (message.role === 'assistant') {
            const toolCalls = message.toolCalls || message.tool_calls;
            if (Array.isArray(toolCalls) && toolCalls.length > 0) out.tool_calls = toolCalls;
        }
        // tool 消息必须携带非空 tool_call_id；缺失的已在上方孤立清理流程中丢弃
        if (message.role === 'tool' && (message.toolCallId || message.tool_call_id)) {
            out.tool_call_id = message.toolCallId || message.tool_call_id;
        }
        // thinking mode（DeepSeek V4 等）：带工具调用轮次的 assistant 消息必须原样回传
        // reasoning_content（含空字符串，字段本身不能丢），否则后续请求会 400
        if (message.role === 'assistant') {
            const reasoning = resolveReasoningContent(message);
            if (reasoning !== undefined) out.reasoning_content = reasoning;
        }
        return out;
    }));
    const served = maybeShadowCompiledRequest(session, system, samplesMessages, finalMessages, multimodal, tools, modelName);
    return (served ?? finalMessages) as RequestMessage[];
}

export function buildContent(message: ContextMessage): string {
    if (message.contentItems && message.contentItems.length > 0) {
        // 用户消息逐条补上发送者/时间/消息ID：连续多条 user 消息会被合并进同一个
        // contentItems，若只在消息级补一次前缀，后续条目的发送者会全部丢失。
        // from 只在发送者切换时渲染（相同发送者连续发言省略，节省 token 且更自然）
        if (message.role === 'user') {
            let lastUserId = '';
            return message.contentItems.map(item => {
                let from = '';
                // 系统名义消息（systemName）不参与发送者切换判断，也不渲染 from
                if (item.userId && item.userId !== lastUserId) {
                    from = formatFromPrefix(item.userId);
                }
                if (item.userId) lastUserId = item.userId;
                const prefix = from
                    + (item.systemName ? `[system:${item.systemName}]` : '')
                    + (item.time ? `[time:${fmtDate(item.time)}]` : '')
                    + (item.messageId ? `[msg_id:${item.messageId}]` : '');
                const text = item.text || '';
                // 防注入：系统名义消息（群事件/触发原因/定时器等）成对加边界，明确「背景通知」范围
                return item.systemName ? `${prefix}${text ? ' ' + text : ''} [/system]` : prefix + text;
            }).join('\f');
        }
        // 非用户消息：只保留消息 ID；时间顺序由消息数组本身表达，去掉重复时间前缀。
        return message.contentItems.map(item =>
            (item.messageId ? `[msg_id:${item.messageId}]` : '')
            + (item.text || '')
        ).join('\f');
    }
    if (message.text) {
        // 防注入：工具返回的外部数据（网页/文件/命令等）成对加边界，明确「只读参考」范围
        if (message.role === 'tool') {
            const toolCallId = message.toolCallId || message.tool_call_id || '';
            return `[tool_result${toolCallId ? `:${toolCallId}` : ''}]\n${escapeToolResultBoundary(message.text)}\n[/tool_result]`;
        }
        return message.text;
    }
    return '';
}

/** 把 uid（QQ:xxx）渲染成 [from:名字(QQ号)]，未记录名字时退化为 [from:QQ号] */
function formatFromPrefix(uid: string): string {
    const number = uid.replace(/^.+:/, '');
    const name = User.get(uid).userName;
    return name ? `[from:${name}(${number})]` : `[from:${number}]`;
}

/** 解析 [img:...] 标签里的图片引用（CIR v1：插件 ID / h<sha> / 裸 sha / 头像别名） */
function resolveImageById(id: string): Image | null {
    return Image.resolveRef(id);
}

/**
 * 多模态消息内容：把文本里的 [img:...]/[avatar:...]/[group_avatar:...] 图片标签转成 image_url 内容块直接传给模型，
 * 而不是让模型只看到文本标签；无法解析的图片（如本地路径无可用 URL）保留原标签；纯文本（无图片标签）原样返回字符串。
 * 图片不可用（URL 已确认失效 / QQ 临时直链转换失败）时也只保留文本标签：死链会让模型整轮请求报错，整个会话不回复。
 */
export async function textToMultimodalContent(text: string, opts?: MultimodalBuildOptions): Promise<RequestMessageContent> {
    if (!/\[(?:img|avatar|group_avatar)[:：]/i.test(text)) return text;

    const parts: Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }> = [];
    const segs = text.split(/([[［](?:img|avatar|group_avatar)[:：]?[^\]］]*[\]］])/).filter(Boolean);
    for (const seg of segs) {
        const match = seg.match(/^[[［](img|avatar|group_avatar)[:：]?\s?(.*?)[\]］]$/i);
        if (!match) {
            parts.push({ type: 'text', text: seg });
            continue;
        }
        const type = match[1].toLowerCase();
        const value = match[2].trim();
        const image: Image | null = type === 'avatar'
            ? Image.getUserAvatar(value)
            : type === 'group_avatar'
                ? Image.getGroupAvatar(value)
                : resolveImageById(value);
        // 统一走 CIR 取图：图床按“模型可达性”选 URL/b64；非图床 URL 优先转 b64，失败回退稳定 URL。
        // 头像（qlogo）是稳定公网地址，直接给 URL；死链/临时直链转换失败只留文本标签。
        if (!image || image.isUrlUnusable() || (!!opts?.imagesAsText && image.type === 'url' && !image.base64)) {
            parts.push({ type: 'text', text: seg });
            continue;
        }
        let src = '';
        try {
            src = await withTimeout(() => image.getModelSrc(opts?.model), 10000);
        } catch (e) {
            logger.warning(`多模态图片取图失败，改用文本标签: ${image.imageId}（${e instanceof Error ? e.message : String(e)}）`);
        }
        if (src) parts.push({ type: 'image_url', image_url: { url: src } });
        else parts.push({ type: 'text', text: seg });
    }
    return parts;
}

/** 多模态消息内容：把用户消息里的图片标签转成 image_url 内容块直接传给模型；非用户消息按原逻辑构建纯文本内容。 */
export async function buildMultimodalContent(message: ContextMessage, opts?: MultimodalBuildOptions): Promise<RequestMessageContent> {
    if (message.role !== 'user') return buildContent(message);
    return textToMultimodalContent(buildContent(message), opts);
}

/** 收集请求体里所有非 data: 的图片 URL（模型报「无法下载图片」时用来定位并降级这些图片） */
export function collectImageUrls(messages: RequestMessage[]): string[] {
    const urls: string[] = [];
    for (const message of messages || []) {
        if (!message || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (!part || part.type !== 'image_url') continue;
            const url = part.image_url && part.image_url.url || '';
            if (url && !url.startsWith('data:')) urls.push(url);
        }
    }
    return urls;
}

export function getRoleSetting(ctx: seal.MsgContext) {
    const { ROLE_NAMES, ROLE_SETTINGS, INSTRUCTIONS } = Config.role;
    const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
    let roleIndex = 0;
    if (exists && roleName !== '' && ROLE_NAMES.includes(roleName)) {
        roleIndex = ROLE_NAMES.indexOf(roleName);
        if (roleIndex < 0 || roleIndex >= INSTRUCTIONS.length) roleIndex = 0;
    } else {
        const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
        if (exists2 && roleIndex2 >= 0 && roleIndex2 < INSTRUCTIONS.length) roleIndex = roleIndex2;
    }
    return { roleName, roleIndex, roleSetting: ROLE_SETTINGS[roleIndex] || '' }
}
