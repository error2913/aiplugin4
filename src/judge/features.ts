// 零 LLM 特征层（L2，纯函数）：把「消息快照 + 消息时间线」压成六维硬特征。
//
// 为什么用本地最小接口而不是 session/context 类型：judge 是 L2，session/context 是 L3，
// 反向 import 会直接触发 deps:check（也会把上层类型耦合进判定内核）。这里只接收调用方
// 已归一化的快照（毫秒时间戳/发送者/纯文本/派生态提及位），保证：
// - 纯函数、无全局状态、无 seal 依赖，可直接单测；
// - M3 在「消息去抖 / WAIT 轮末 / 静默探针」三个判定入口复用同一套口径（方案 §6.2）。
//
// 权威口径（方案 §4.7/§6.2）：Addressed/Friendships/SilenceGap/InterruptionRisk 以规则为准；
// HelpSignal/Relevance 只给词面近似（预筛 + 与 LLM 交叉校验），不参与最终决策；无数据记 0。
//
// 时间窗口常量（方案要求）：15s 密度、60s 消息数、5 分钟消息率、最近 10 分钟有人。

/** 特征统计窗口常量 */
export const FEATURE_WINDOWS = {
    /** 消息密度窗口：15s 内条数（≥ DENSITY_LIMIT 视为刷屏） */
    densityMs: 15 * 1000,
    /** 60s 消息数：爆发度 */
    recentMs: 60 * 1000,
    /** 5 分钟消息率：SilenceGap 的 λ 来源 */
    rateMs: 5 * 60 * 1000,
    /** 最近 10 分钟有人：静默探针的在场条件 */
    presenceMs: 10 * 60 * 1000,
} as const;

/** 15s 窗口条数上限（对应方案 [features] density_limit 默认 5；≥ 视为刷屏） */
export const DENSITY_LIMIT = 5;

/** SilenceGap 归一化尺度：s = λ×沉默秒，score = clamp(s/2.5, 0, 1)（热群沉默 2 分钟 ≈ 4 → 封顶 1.0） */
export const SILENCE_SCALE_SEC = 2.5;

/** 「最近 120s 内被 @/引用过」仍算在与 bot 对话的回看窗口（去抖上限 12s 的余量） */
const ADDRESSED_LOOKBACK_MS = 120 * 1000;

/** Friendships 上下文近似的互动回看窗口（P1 近似：不建持久统计，方案 §6.2 决策 7） */
const FRIENDSHIP_WINDOW_MS = 30 * 60 * 1000;

/** 一条已归一化的判定上下文字迹（调用方负责把消息段转成纯文本与派生态标记） */
export interface JudgeContextMessage {
    /** 角色：user / assistant（bot 自身发言）/ system */
    role: string;
    /** 发送者 UNI-ID（system 消息、旧存档可缺失） */
    userId?: string;
    /** 纯文本正文（不含 CQ 码/图片 base64：判定 prompt 不接收原始消息段） */
    text: string;
    /** 毫秒时间戳；缺失视为未知，不计入时间窗口统计 */
    time?: number;
    /** 该条是否出现对 bot 的 at/引用（由调用方从消息段派生，judge 不解析 seal 类型） */
    mentionsBot?: boolean;
    /** 该条是否出现对其他人的 at（用于「连续 @ 第三人」风险近似） */
    mentionsOthers?: boolean;
}

/** 特征抽取的本地最小输入（M3 负责把 Session/Context 投影成这个形状） */
export interface JudgeFeatureInput {
    /** 供 Addressed/Friendships/Relevance 使用的上下文消息（时间升序；可含 bot 自身消息） */
    messages: JudgeContextMessage[];
    /** 群消息时间线（毫秒），可与 messages 不同源；用于密度/速率/爆发统计 */
    msgTimes: number[];
    /** 与 msgTimes 同序的发送者 id（含 bot 自身；长度不足按 undefined 处理），用于交替率统计 */
    senderIds: (string | undefined)[];
    /** bot 自身的 UNI-ID（用于区分 bot/人类消息） */
    botId: string;
    /** 是否群聊（私聊天然是在对 bot 说话；静默探针也只在群聊启用） */
    isGroup: boolean;
    /** 当前时间（毫秒）：显式传入保证纯函数可测 */
    now: number;
    /** 全局活跃时间窗口（本地分钟数，跨 0 点允许 start>end）；缺省 = 不受限 */
    activeWindow?: { startMin: number; endMin: number };
    /** 当前候选消息；提供了就只按它算 Addressed/HelpSignal/Relevance（判定入口的「当前候选」） */
    candidate?: JudgeContextMessage;
    /** bot 名/别名：用于 Addressed 的词面称呼近似 */
    botNames?: string[];
    /** 角色设定全文：用于 Relevance 词面近似（LLM 仍以角色全文判相关） */
    roleSetting?: string;
    /** 密度上限（[features] density_limit；缺省用常量 5） */
    densityLimit?: number;
}

/** 六维特征（0~1；friendships 允许 -1~1） */
export interface JudgeDims {
    addressed: number;
    help_signal: number;
    relevance: number;
    friendships: number;
    silence_gap: number;
    interruption_risk: number;
}

/** 零 LLM 统计字段（只进日志/预筛，不参与 policy 阈值比较） */
export interface JudgeFeatureStats {
    /** 15s 窗口消息数（密度） */
    count15s: number;
    /** 60s 窗口消息数（爆发度） */
    count60s: number;
    /** 5 分钟窗口消息数（消息率） */
    count5m: number;
    /** 最近一条消息距 now 的秒数（无任何消息时间记为 0） */
    silenceSec: number;
    /** 5 分钟消息率（条/分钟，日志用） */
    ratePerMin: number;
    /** 最近 10 分钟内是否有人说话（探针在场条件） */
    someoneRecent: boolean;
    /** 当前是否处于活跃时间窗口（未配置 = true，即不受限） */
    inActiveWindow: boolean;
    /** 密度得分（0~1） */
    densityScore: number;
    /** 爆发度（0~1） */
    burstiness: number;
    /** 发送者交替率（0~1） */
    alternationRate: number;
}

/** 特征层输出：六维 + 统计（stats 只做日志/调试，不进权重） */
export interface JudgeFeatures extends JudgeDims {
    stats: JudgeFeatureStats;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

function clampSymmetric(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(-1, value));
}

/** 四舍五入到 n 位小数：消除浮点尾差，让日志/单测断言稳定 */
function round(value: number, digits: number): number {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

/** 取本地时区的「当天分钟数」，用于活跃时间窗口判断 */
function minuteOfDay(now: number): number {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
}

/** 判断 now 是否在活跃时间窗口内（跨 0 点：start > end 表示跨午夜） */
function inActiveWindow(window: { startMin: number; endMin: number } | undefined, now: number): boolean {
    if (!window) return true; // 未配置 = 不受限（探针「未配置不启用」是调用方/调度层的闸，不在几何判断里表达）
    const start = Number.isFinite(window.startMin) ? window.startMin : 0;
    const end = Number.isFinite(window.endMin) ? window.endMin : 0;
    if (start === end) return true; // 起止相同视为全天（避免配置成 0-0 时永远不触发）
    const m = minuteOfDay(now);
    return start < end ? m >= start && m < end : m >= start || m < end;
}

/** 过滤 + 升序排列时间线（不修改入参；未来时间/非数值一律丢弃） */
function sortedTimes(times: readonly number[] | undefined, now: number): number[] {
    if (!Array.isArray(times)) return [];
    return times.filter((t) => Number.isFinite(t) && t <= now).sort((a, b) => a - b);
}

/** 窗口内条数（与现状 gate 的 `t > windowStart` 口径一致：边界点不算命中） */
function countInWindow(times: readonly number[], now: number, windowMs: number): number {
    const start = now - windowMs;
    let count = 0;
    for (const t of times) if (t > start) count++;
    return count;
}

/** 取候选消息：显式传入优先，否则用最后一条非 bot 消息（消息入口的「最新一条」） */
function pickCandidate(input: JudgeFeatureInput, messages: readonly JudgeContextMessage[]): JudgeContextMessage | null {
    if (input.candidate && typeof input.candidate === 'object') return input.candidate;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') return messages[i];
    }
    return messages.length > 0 ? messages[messages.length - 1] : null;
}

/** 候选之前的历史（用于「上一条是不是 bot 发言」这类近邻判断） */
function messagesBefore(
    messages: readonly JudgeContextMessage[],
    candidate: JudgeContextMessage | null,
): readonly JudgeContextMessage[] {
    if (!candidate) return messages;
    const index = messages.indexOf(candidate);
    return index >= 0 ? messages.slice(0, index) : messages;
}

function textOf(message: JudgeContextMessage | null | undefined): string {
    return String(message?.text ?? '');
}

function isQuestionLike(text: string): boolean {
    if (/[?？]/.test(text)) return true;
    return /(吗|呢|怎么|如何|为什么|为何|是不是|能不能|可不可以|有没有|什么|哪里|哪个|多少|请问|求助|帮我|帮忙|咋办|怎么办)/.test(text);
}

function mentionsName(text: string, names: readonly string[]): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return names.some((name) => {
        const n = String(name ?? '').trim().toLowerCase();
        return n.length > 0 && lower.includes(n);
    });
}

/** Addressed（规则权威）：@/引用 1.0 > 词面称呼 0.7 > 追问 bot 0.4；私聊天然 1.0 */
function computeAddressed(
    input: JudgeFeatureInput,
    candidate: JudgeContextMessage | null,
    messages: readonly JudgeContextMessage[],
): number {
    if (!input.isGroup) return 1; // 私聊里每条消息都是对 bot 说的
    if (!candidate) return 0;
    const names = Array.isArray(input.botNames) ? input.botNames : [];
    let score = 0;
    if (candidate.mentionsBot) score = 1;
    // 去抖窗口内的 @/引用：哪怕候选不是被 @ 的那条，也说明对话仍指向 bot
    const recentlyAddressed = messages.some((m) => m !== candidate
        && m.role !== 'assistant'
        && m.mentionsBot === true
        && typeof m.time === 'number'
        && input.now - m.time <= ADDRESSED_LOOKBACK_MS);
    if (recentlyAddressed) score = Math.max(score, 0.7);
    if (mentionsName(textOf(candidate), names)) score = Math.max(score, 0.7);
    // 弱信号：候选是追问，且紧邻的上一段对话是 bot 发言（「那然后呢？」这类接话）
    const before = messagesBefore(messages, candidate);
    let lastBotIndex = -1;
    for (let i = before.length - 1; i >= 0; i--) {
        if (before[i].role === 'assistant') {
            lastBotIndex = i;
            break;
        }
    }
    if (lastBotIndex >= 0 && isQuestionLike(textOf(candidate))) score = Math.max(score, 0.4);
    return round(clamp01(score), 3);
}

/** HelpSignal（词面，仅预筛）：问号 + 疑问词 + 求助词，叠加后封顶 1.0 */
function computeHelpSignal(candidate: JudgeContextMessage | null): number {
    const text = textOf(candidate);
    if (!text) return 0;
    let score = 0;
    if (/[?？]/.test(text)) score += 0.4;
    const questionWords = text.match(/(吗|呢|怎么|如何|为什么|为何|是不是|能不能|可不可以|有没有|什么|哪里|哪个|多少|请问|求助|帮我|帮忙|求问|咋办|怎么办)/g);
    const q = questionWords ? questionWords.length : 0;
    if (q > 0) score += Math.min(0.35, 0.2 + 0.15 * (q - 1));
    if (/(求助|帮我|帮忙|请问|求问|help|assist|support|could you|can you|please)/i.test(text)) score += 0.35;
    return round(clamp01(score), 3);
}

/** 中文停用字符：避免「的/了/是」这类高频字把无关文本算成相关 */
const STOP_CHARS = new Set('的了是我你他她它在有就不也都和与这那吗呢啊吧哦嗯呀'.split(''));

/** 词面 n-gram 集合：CJK 取 2-gram（过滤停用字），ASCII 取整词（≥2 字符） */
function nGramSet(text: string): Set<string> {
    const set = new Set<string>();
    const lower = String(text ?? '').toLowerCase();
    for (const word of lower.match(/[a-z0-9_]+/g) || []) {
        if (word.length >= 2) set.add(`w:${word}`);
    }
    for (const run of lower.match(/[\u3400-\u9fff]+/g) || []) {
        const chars = [...run].filter((ch) => !STOP_CHARS.has(ch));
        if (chars.length === 1) set.add(`c:${chars[0]}`);
        for (let i = 0; i + 1 < chars.length; i++) set.add(`c:${chars[i]}${chars[i + 1]}`);
    }
    return set;
}

/** a 的 n-gram 有多少比例出现在 b 中（0~1） */
function overlapRatio(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let hit = 0;
    for (const gram of a) if (b.has(gram)) hit++;
    return hit / a.size;
}

/** Relevance（词面，仅预筛；P1 不做 embedding）：候选 vs 角色设定 + 最近话题的 n-gram 重叠 */
function computeRelevance(
    input: JudgeFeatureInput,
    candidate: JudgeContextMessage | null,
    messages: readonly JudgeContextMessage[],
): number {
    const text = textOf(candidate);
    if (!text) return 0;
    const candidateGrams = nGramSet(text);
    const before = messagesBefore(messages, candidate);
    const recentTexts = before
        .filter((m) => m.role !== 'assistant')
        .slice(-5)
        .map((m) => textOf(m))
        .join('\n');
    const roleSetting = typeof input.roleSetting === 'string' ? input.roleSetting.trim() : '';
    const roleScore = roleSetting ? overlapRatio(candidateGrams, nGramSet(roleSetting)) : 0;
    const topicScore = overlapRatio(candidateGrams, nGramSet(recentTexts));
    const score = roleSetting ? 0.6 * roleScore + 0.4 * topicScore : topicScore;
    return round(clamp01(score), 3);
}

/** Friendships（规则权威，P1 上下文近似，-1~1）：窗口内互动次数 + bot 是否回过 + 是否 @ */
function computeFriendships(
    input: JudgeFeatureInput,
    candidate: JudgeContextMessage | null,
    messages: readonly JudgeContextMessage[],
): number {
    const sender = candidate?.userId;
    if (!sender) return 0; // 无数据记 0（中性）
    const recentFromSender = messages.filter((m) => m.role !== 'assistant'
        && m.userId === sender
        && (typeof m.time !== 'number' || input.now - m.time <= FRIENDSHIP_WINDOW_MS));
    const senderCount = recentFromSender.length;
    // bot 回应该发送者的次数：assistant 消息往前找最近一条非 bot 消息，若同发送者则算一次互动
    let botReplies = 0;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'assistant') continue;
        for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
            if (messages[j].role === 'assistant') continue;
            if (messages[j].userId === sender) botReplies++;
            break;
        }
    }
    let score = 0;
    score += Math.min(0.4, 0.1 * Math.max(0, senderCount - 1)); // 熟客：窗口内多次出现
    score += Math.min(0.3, 0.1 * botReplies); // 之前与 bot 有过对话
    if (candidate?.mentionsBot) score += 0.2;
    if (senderCount <= 1) score -= 0.2; // 只说过一句 = 偏陌生
    return round(clampSymmetric(score), 2);
}

/** 发送者交替率：60s 内最近 10 条相邻消息的发送者切换比例（0~1） */
function computeAlternation(
    senderIds: readonly (string | undefined)[] | undefined,
    msgTimes: readonly number[],
    now: number,
): number {
    if (!Array.isArray(senderIds) || msgTimes.length === 0) return 0;
    const pairs: { sender: string; time: number }[] = [];
    const length = Math.min(senderIds.length, msgTimes.length);
    for (let i = 0; i < length; i++) {
        const sender = senderIds[i];
        const time = msgTimes[i];
        if (typeof sender !== 'string' || sender === '' || !Number.isFinite(time)) continue;
        if (now - time > FEATURE_WINDOWS.recentMs) continue;
        pairs.push({ sender, time });
    }
    const recent = pairs.slice(-10);
    if (recent.length < 2) return 0;
    let switches = 0;
    for (let i = 1; i < recent.length; i++) if (recent[i].sender !== recent[i - 1].sender) switches++;
    return round(clamp01(switches / (recent.length - 1)), 3);
}

/** 「连续 @ 第三人」近似：末尾连续多少条非 bot 消息在 @ 别人（2 条即满分） */
function computeConsecutiveOtherMentions(messages: readonly JudgeContextMessage[]): number {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant') break;
        if (m.mentionsOthers !== true) break;
        count++;
        if (count >= 2) break;
    }
    return count >= 2 ? 1 : count / 2;
}

/**
 * 抽取六维特征 + 统计。
 *
 * InterruptionRisk 权重（0.8/0.1/0.05/0.05）：密度是唯一能单独达到 veto(默认 0.8) 的信号——
 * 15s 窗口满 5 条（现状 gate 的刷屏 DROP 口径）时 risk=0.8，会被策略层硬否决；其余信号只做加成。
 */
export function extractFeatures(input: JudgeFeatureInput): JudgeFeatures {
    const now = Number.isFinite(input?.now) ? (input.now as number) : 0;
    const messages = Array.isArray(input?.messages) ? input.messages.filter((m) => m && typeof m === 'object') : [];
    const timeline = sortedTimes(input?.msgTimes, now);
    const candidate = pickCandidate(input, messages);

    const count15s = countInWindow(timeline, now, FEATURE_WINDOWS.densityMs);
    const count60s = countInWindow(timeline, now, FEATURE_WINDOWS.recentMs);
    const count5m = countInWindow(timeline, now, FEATURE_WINDOWS.rateMs);
    const count10m = countInWindow(timeline, now, FEATURE_WINDOWS.presenceMs);
    const silenceSec = timeline.length > 0 ? Math.max(0, (now - timeline[timeline.length - 1]) / 1000) : 0;
    const someoneRecent = count10m > 0;

    const densityLimit = Number.isFinite(input?.densityLimit) && (input.densityLimit as number) > 0
        ? (input.densityLimit as number)
        : DENSITY_LIMIT;
    const densityScore = round(clamp01(count15s / densityLimit), 3);
    const burstiness = round(clamp01((count60s - 10) / 20), 3);
    const alternationRate = computeAlternation(input?.senderIds, timeline, now);
    const otherRisk = computeConsecutiveOtherMentions(messages);

    const stats: JudgeFeatureStats = {
        count15s,
        count60s,
        count5m,
        silenceSec: round(silenceSec, 1),
        ratePerMin: round(count5m / (FEATURE_WINDOWS.rateMs / 60000), 2),
        someoneRecent,
        inActiveWindow: inActiveWindow(input?.activeWindow, now),
        densityScore,
        burstiness,
        alternationRate,
    };

    // SilenceGap：λ（5 分钟消息率，条/秒）× 沉默秒 → clamp(s/2.5, 0, 1)；只在探针场景有意义，
    // 因此非群聊/不在活跃窗口/最近 10 分钟没人时一律 0（消息事件里 t≈0，自然也接近 0）。
    let silenceGap = 0;
    if (input?.isGroup && stats.inActiveWindow && someoneRecent) {
        const lambdaPerSec = count5m / (FEATURE_WINDOWS.rateMs / 1000);
        const silenceScore = (lambdaPerSec * silenceSec) / SILENCE_SCALE_SEC;
        silenceGap = round(clamp01(silenceScore), 3);
    }

    const interruptionRisk = round(clamp01(
        0.8 * densityScore + 0.1 * burstiness + 0.05 * alternationRate + 0.05 * otherRisk,
    ), 3);

    return {
        addressed: computeAddressed(input, candidate, messages),
        help_signal: computeHelpSignal(candidate),
        relevance: computeRelevance(input, candidate, messages),
        friendships: computeFriendships(input, candidate, messages),
        silence_gap: silenceGap,
        interruption_risk: interruptionRisk,
        stats,
    };
}
