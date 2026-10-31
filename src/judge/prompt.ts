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

/** 判定输入的数据准备（messages 与 System One 共用，保证两条路径输入同源） */
export interface PreparedJudgeData {
    now: number;
    botName: string;
    botId?: string;
    budget: number;
    selected: JudgePromptHistoryItem[];
    historyCount: number;
    historyTokens: number;
    role: string;
    globalPrompt: string;
    dataBoundary: string;
    system: string;
}

export function prepareJudgeData(input: BuildJudgePromptInput): PreparedJudgeData {
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
    const historyTokens = selected.reduce(
        (sum, item, index) => sum + estimateTextTokens(renderHistoryLine(item, index)) + 4,
        0,
    );

    return {
        now,
        botName,
        botId: input.botId,
        budget,
        selected,
        historyCount: selected.length,
        historyTokens,
        role: capToTokens(input.roleSetting ?? '', PROMPT_BUDGETS.roleTokens),
        globalPrompt: capToTokens(input.globalPrompt ?? '', PROMPT_BUDGETS.globalPromptTokens),
        dataBoundary: texts.judgeDataBoundary().trim(),
        system,
    };
}

/**
 * 组装判定 messages：system = 任务/六维/输出规范（+ [prompt] extra），
 * user = 数据边界声明 + bot 信息 + 角色 + 历史（token 预算内）+ 硬特征 + 当前候选。
 */
export function buildJudgeMessages(input: BuildJudgePromptInput): BuiltJudgeMessages {
    const prepared = prepareJudgeData(input);
    const { now, botName, selected, budget } = prepared;

    const historyLines = selected.map((item, index) => renderHistoryLine(item, index));
    const historyText = historyLines.length > 0
        ? historyLines.join('\n')
        : (budget > 0 ? '(no recent history)' : '(history injection disabled: context_tokens = 0)');

    const dataLines: string[] = [];
    dataLines.push(prepared.dataBoundary);
    dataLines.push('');
    dataLines.push(`Bot name: ${botName}`);
    if (input.botId) dataLines.push(`Bot account: ${input.botId}`);
    dataLines.push(`Bot role setting: ${prepared.role || '(none)'}`);
    if (prepared.globalPrompt) dataLines.push(`Global instructions: ${prepared.globalPrompt}`);
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
            { role: 'system', content: prepared.system },
            { role: 'user', content: user },
        ],
        system: prepared.system,
        user,
        historyCount: prepared.historyCount,
        historyTokens: prepared.historyTokens,
    };
}

/** 模型输出的 JSON Schema（json_schema 档用）：六维 0~10，不含 decision/confidence/reason。 */
export function buildJudgeOutputSchema(): Record<string, unknown> {
    const unit = { type: 'number', minimum: 0, maximum: 10 };
    return {
        type: 'object',
        additionalProperties: false,
        required: ['dims'],
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
                    friendships: unit,
                    silence_gap: unit,
                    interruption_risk: unit,
                },
            },
        },
    };
}

/** System One 的六维 score 问题（低 → 高 10 档；按 criteria.length-1 映射到 0~10） */
export type JudgeScoreQuestionKey =
    'addressed' | 'help_signal' | 'relevance' | 'friendships' | 'silence_gap' | 'interruption_risk';

export interface JudgeScoreQuestion {
    type: 'score';
    instructions: string;
    criteria: string[];
}

export const JUDGE_SCORE_QUESTIONS: Record<JudgeScoreQuestionKey, JudgeScoreQuestion> = {
    addressed: {
        type: 'score',
        instructions: 'How clearly does the current message target this bot (mention, quote, or calling its name)?',
        criteria: [
            'Not addressed to the bot at all',
            'Very indirectly related to the bot',
            'Slightly related to the bot',
            'Partially addresses the bot',
            'Moderately addresses the bot',
            'Clearly addresses the bot',
            'Strongly addresses the bot',
            'Directly addresses the bot',
            'Almost certainly meant for the bot',
            'Explicitly @-mentions, quotes, or calls the bot',
        ],
    },
    help_signal: {
        type: 'score',
        instructions: 'How strongly does the message ask for help this bot is able to give?',
        criteria: [
            'No request for help',
            'A very faint hint of a request',
            'A weak hint of a request',
            'A mild request for help',
            'A moderate request for help',
            'A clear request for help',
            'A strong request for help',
            'A pressing request for help',
            'An urgent request for help',
            'An explicit urgent request for help',
        ],
    },
    relevance: {
        type: 'score',
        instructions: "How relevant is the message to the bot's persona or the current topic?",
        criteria: [
            'Completely off-topic',
            'Barely related to the topic',
            'Loosely related to the topic',
            'Somewhat related to the topic',
            'Related to the topic',
            'Clearly relevant to the topic',
            'Highly relevant to the topic',
            'Very highly relevant to the topic',
            'Directly on the current topic',
            "Directly on the bot's persona or current topic",
        ],
    },
    friendships: {
        type: 'score',
        instructions: 'How familiar and friendly is the sender with the bot?',
        criteria: [
            'Hostile or complete stranger',
            'Very distant',
            'Distant',
            'Slightly distant',
            'Neutral',
            'Slightly familiar',
            'Familiar',
            'Quite familiar',
            'Close',
            'Close friend',
        ],
    },
    silence_gap: {
        type: 'score',
        instructions: 'How quiet has the conversation been relative to its recent pace?',
        criteria: [
            'Very active',
            'Active',
            'Fairly active',
            'Slightly active',
            'Normal',
            'Slightly quiet',
            'Quiet',
            'Very quiet',
            'Long silence',
            'Extremely long silence',
        ],
    },
    interruption_risk: {
        type: 'score',
        instructions: 'How risky would it be for the bot to interject right now?',
        criteria: [
            'No risk',
            'Very low risk',
            'Low risk',
            'Slightly low risk',
            'Moderate risk',
            'Slightly high risk',
            'High risk',
            'Very high risk',
            'Severe risk',
            'Extremely high risk',
        ],
    },
};

export interface SystemOnePayload {
    state: Record<string, unknown>;
    questions: Record<JudgeScoreQuestionKey, JudgeScoreQuestion>;
    historyCount: number;
    historyTokens: number;
}

/** 把同一份判定输入渲染成 System One 的 state + questions（与 LLM messages 同源） */
export function buildSystemOnePayload(input: BuildJudgePromptInput): SystemOnePayload {
    const prepared = prepareJudgeData(input);
    const history = prepared.selected.map(item => ({
        role: item.role,
        from: item.userId ?? null,
        time: item.time ?? null,
        text: item.text,
    }));
    const state: Record<string, unknown> = {
        bot: { name: prepared.botName, account: input.botId ?? null },
        role: prepared.role || null,
        globalInstructions: prepared.globalPrompt || null,
        currentTime: formatTime(prepared.now),
        hardFeatures: input.features ?? null,
        history,
        candidate: input.candidate ? {
            role: input.candidate.role,
            from: input.candidate.userId ?? null,
            time: input.candidate.time ?? null,
            text: input.candidate.text,
        } : null,
        dataBoundary: prepared.dataBoundary,
    };
    return {
        state,
        questions: JUDGE_SCORE_QUESTIONS,
        historyCount: prepared.historyCount,
        historyTokens: prepared.historyTokens,
    };
}
