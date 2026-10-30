// 判定 prompt 装配（L2，纯数据装配，不发请求）。
//
// 分层约束（方案 §6.6 审计修正）：`src/judge/**` 是 L2，`src/prompt/**` 是 L3——
// 所以文案只能经 L0 端口 `core/ports/prompt_texts` 取（由 L3 在装配时注册），本文件
// 不 import `src/prompt/**`，也不 import session/context（M3 负责把数据投影成入参）。
//
// 职责边界：这里只回答「数据怎么摆」——bot 名/QQ、角色、全局提示词、token 预算内的历史、
// 硬特征 JSON、当前候选（独立字段，不拼进历史以免重复）。提示词内容/六维定义/输出 schema
// 的「文字」都在 ports 端口里；结构化 schema 由 `buildJudgeOutputSchema` 提供给 M3 的请求层。
import { getPromptTexts } from '../core/ports/prompt_texts';
import { truncateToTokenBudget } from '../utils/token_budget';
import { estimateTextTokens } from '../utils/token_estimate';

import { selectHistoryByTokens } from './context_select';
import type { JudgeFeatures } from './features';

/** prompt 内各数据区预算（默认值与方案 §4.8 的 [model] context_tokens / 角色全文截断一致） */
export const PROMPT_BUDGETS = {
    /** [model] context_tokens 默认 1500：judge 上下文的唯一范围口径；0 = 不注入历史 */
    contextTokens: 1500,
    /** 角色设定全文截断预算（方案 §6.6「角色全文按 token 预算截断」） */
    roleTokens: 600,
    /** 全局提示词截断预算（开关默认关，调用方决定是否传） */
    globalPromptTokens: 300,
    /** #145 `[prompt] extra` 截断预算（追加到 system 末尾，不做整段覆盖） */
    extraTokens: 300,
} as const;

/** 输入给模板的历史消息（文本必须已归一化：无 CQ、无 base64；判定 prompt 不收原始消息段） */
export interface JudgePromptHistoryItem {
    /** 角色：user / assistant（bot）/ system */
    role: string;
    /** 纯文本正文 */
    text: string;
    /** 毫秒时间戳（渲染时间戳用） */
    time?: number;
    /** 发送者 UNI-ID（渲染发言人用） */
    userId?: string;
}

/** 当前候选消息（与历史同形状；语义上是「独立字段」，不参与历史 token 预算） */
export type JudgePromptCandidate = JudgePromptHistoryItem;

/** `buildJudgeMessages` 入参：全部是已投影好的纯数据（不依赖 seal/Session/Config） */
export interface BuildJudgePromptInput {
    /** bot 名（骰子名字） */
    botName: string;
    /** bot 账号/QQ（可选，给模型对齐 @/引用目标） */
    botId?: string;
    /** 角色设定全文（按 token 预算截断后注入） */
    roleSetting?: string;
    /** 全局提示词（方案 §6.6；默认关，调用方决定是否传） */
    globalPrompt?: string;
    /** 历史消息（旧 → 新，不含当前候选；由调用方按 context 投影裁剪） */
    history?: JudgePromptHistoryItem[];
    /** 当前候选消息（独立字段，不拼进历史） */
    candidate?: JudgePromptCandidate | null;
    /** 零 LLM 硬特征（含 stats；只做参考数据） */
    features?: JudgeFeatures | null;
    /** 上下文 token 预算；缺省 1500，0 = 不注入历史 */
    contextTokens?: number;
    /** #145 `[prompt] extra`：追加到 system 末尾 */
    promptExtra?: string;
    /** 当前时间（毫秒）；缺省 Date.now() */
    now?: number;
}

/** 装配结果（messages 可直接交给 aux LLM 端口） */
export interface BuiltJudgeMessages {
    messages: { role: 'system' | 'user'; content: string }[];
    system: string;
    user: string;
    /** 实际注入的历史条数（日志用） */
    historyCount: number;
    /** 实际注入的历史估算 token（日志用） */
    historyTokens: number;
}

/** M3 接 stream 时的请求描述：messages + 期望输出说明（不实际发请求） */
export interface JudgeDecisionRequest {
    messages: { role: 'system' | 'user'; content: string }[];
    expected: {
        /** json_schema 档使用的结构（JSON Schema 子集；M3 决定是否下发） */
        schema: Record<string, unknown>;
        /** 纯提示词档使用的输出说明文本 */
        instruction: string;
    };
    historyCount: number;
    historyTokens: number;
}

function pad2(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

/** 本地时间 `MM-DD HH:mm`：判定只看「多久以前」，不追求完整时区信息 */
function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 按 token 预算截断一段文本（角色/全局提示词/extra 用），超限追加省略号提示被裁剪 */
function capToTokens(text: string, maxTokens: number): string {
    const source = String(text ?? '').trim();
    if (!source) return '';
    const slice = truncateToTokenBudget(source, maxTokens, estimateTextTokens);
    return slice.truncated ? `${slice.text}…` : slice.text;
}

function roleLabel(role: string): string {
    if (role === 'assistant') return 'Bot';
    if (role === 'system') return 'System';
    return 'User';
}

/** 渲染一条历史的元信息：`[10-31 03:42 User QQ:123]` */
function renderMeta(item: JudgePromptHistoryItem): string {
    const when = typeof item.time === 'number' && Number.isFinite(item.time) ? `${formatTime(item.time)} ` : '';
    const who = item.userId ? ` ${item.userId}` : '';
    return `[${when}${roleLabel(item.role)}${who}]`;
}

/** 历史行（带序号：模型的 evidence 用序号引用，虽然不参与决策） */
function renderHistoryLine(item: JudgePromptHistoryItem, index: number): string {
    return `#${index} ${renderMeta(item)} ${item.text}`;
}

/** 当前候选行：`[current] [10-31 03:42 User QQ:123] ...` */
function renderCandidateLine(item: JudgePromptCandidate): string {
    return `[current] ${renderMeta(item)} ${item.text}`;
}

/**
 * 组装判定 messages：system = 任务/六维/输出规范（+ [prompt] extra），
 * user = 数据边界声明 + bot 信息 + 角色 + 历史（token 预算内）+ 硬特征 + 当前候选。
 */
export function buildJudgeMessages(input: BuildJudgePromptInput): BuiltJudgeMessages {
    const texts = getPromptTexts();
    const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();
    const botName = String(input.botName ?? '').trim() || '(unknown)';

    const systemSections = [texts.judgeSystem().trim(), texts.judgeOutputSpec().trim()];
    const extra = capToTokens(input.promptExtra ?? '', PROMPT_BUDGETS.extraTokens);
    if (extra) systemSections.push(extra);
    const system = systemSections.filter(Boolean).join('\n\n');

    const history = Array.isArray(input.history)
        ? input.history.filter((item) => item && typeof item === 'object')
        : [];
    const budget = Number.isFinite(input.contextTokens)
        ? Math.max(0, input.contextTokens as number)
        : PROMPT_BUDGETS.contextTokens;
    // 当前候选是独立字段，历史选择用严格预算（alwaysKeepLatest=false）：超预算的最新历史条目
    // 可以丢，当前候选一定会被注入，不会出现「只看到历史看不到候选」。
    const selected = budget > 0
        ? selectHistoryByTokens(
            history,
            budget,
            (item) => estimateTextTokens(renderHistoryLine(item, 0)) + 4,
            { alwaysKeepLatest: false },
        )
        : [];
    const historyLines = selected.map((item, index) => renderHistoryLine(item, index));
    const historyTokens = selected.reduce(
        (sum, item, index) => sum + estimateTextTokens(renderHistoryLine(item, index)) + 4,
        0,
    );
    const historyText = historyLines.length > 0
        ? historyLines.join('\n')
        : (budget > 0 ? '(no recent history)' : '(history injection disabled: context_tokens = 0)');

    const dataLines: string[] = [];
    dataLines.push(texts.judgeDataBoundary().trim());
    dataLines.push('');
    dataLines.push(`Bot name: ${botName}`);
    if (input.botId) dataLines.push(`Bot account: ${input.botId}`);
    const role = capToTokens(input.roleSetting ?? '', PROMPT_BUDGETS.roleTokens);
    dataLines.push(`Bot role setting: ${role || '(none)'}`);
    const globalPrompt = capToTokens(input.globalPrompt ?? '', PROMPT_BUDGETS.globalPromptTokens);
    if (globalPrompt) dataLines.push(`Global instructions: ${globalPrompt}`);
    dataLines.push(`Current time: ${formatTime(now)}`);
    dataLines.push('');
    if (input.features) {
        dataLines.push('Hard features (zero-LLM, reference only; friendships -1..1, all others 0..1):');
        dataLines.push(JSON.stringify(input.features));
        dataLines.push('');
    }
    dataLines.push('Recent group-chat history (oldest -> newest, not including the current message):');
    dataLines.push(historyText);
    dataLines.push('');
    dataLines.push('Current message to evaluate:');
    dataLines.push(input.candidate ? renderCandidateLine(input.candidate) : '(no current message)');
    dataLines.push('');
    dataLines.push('Evaluate only the current message and return the JSON object described above.');

    const user = dataLines.join('\n');
    return {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        system,
        user,
        historyCount: selected.length,
        historyTokens,
    };
}

/**
 * 模型输出的 JSON Schema（json_schema 档用；严格档不支持的模型由 M3 降级到 json_object/纯提示词）。
 * 六维 + decision/confidence/reason 必填，evidence 可选；范围与解析层的钳制口径一致。
 */
export function buildJudgeOutputSchema(): Record<string, unknown> {
    const unit = { type: 'number', minimum: 0, maximum: 1 };
    return {
        type: 'object',
        additionalProperties: false,
        required: ['dims', 'decision', 'confidence', 'reason'],
        properties: {
            dims: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'addressed', 'help_signal', 'relevance', 'friendships', 'silence_gap', 'interruption_risk',
                ],
                properties: {
                    addressed: unit,
                    help_signal: unit,
                    relevance: unit,
                    friendships: { type: 'number', minimum: -1, maximum: 1 },
                    silence_gap: unit,
                    interruption_risk: unit,
                },
            },
            decision: { type: 'string', enum: ['SPEAK', 'WAIT', 'IGNORE'] },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            reason: { type: 'string', maxLength: 200 },
            evidence: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 20 },
        },
    };
}

/**
 * M3 组装判定请求时使用：返回 messages + 期望输出说明（schema + 纯提示词档说明），
 * **不实际调用模型**（调用/超时/重试/三档降级都在 M3 的请求层）。
 */
export function buildDecisionRequest(input: BuildJudgePromptInput): JudgeDecisionRequest {
    const built = buildJudgeMessages(input);
    return {
        messages: built.messages,
        expected: {
            schema: buildJudgeOutputSchema(),
            instruction: getPromptTexts().judgeOutputSpec().trim(),
        },
        historyCount: built.historyCount,
        historyTokens: built.historyTokens,
    };
}
