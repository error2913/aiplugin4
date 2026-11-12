// 记忆增量注入的候选层（#163 D3/D5，纯函数，L2 能力层）。
//
// 职责边界（执行方案 I-05 / REQ-D3-03）：
// - 本文件只做「预算计算 + 候选解析 + 增量选择」，不写盘、不发请求、不 import `src/prompt/**`；
// - 渲染（块头 / bank 分组标题 / 块尾 guard / 协议包装）由 `src/prompt/injections/memory.ts` 负责；
// - 写块、去重判定、锚点、记账、释放全部由 `src/context/**` 框架负责。
//
// 预算三值（r2 §2.3，不可改成"可配置"）：窗口 4096 / 单轮 512 / 最小余量 24。
// 硬语义：达上限只停注、不强释放；`room < 24` ⇒ 整轮不算记忆（零成本稳态，连 recall 都不做）。
import { DEFAULT_MEMORY_PROMPT_TOKENS } from "./prompt";
import { fnv1a32 } from "./templates";

/** 活跃注入窗口上限（≈2× 单轮预算） */
export const MEMORY_INJECT_WINDOW = 4096;
/** 稳态单轮新增上限 */
export const MEMORY_INJECT_DELTA = 512;
/** 低于此余量整轮不算记忆（零成本稳态） */
export const MEMORY_INJECT_MIN_ROOM = 24;
/** 单条目正文定稿上限（创建时截断一次，之后不再重渲染，避免 `r` 抖动） */
export const MEMORY_INJECT_MAX_ITEM_CHARS = 1000;
/**
 * 活动记忆条目 → token 的粗估系数（只用于**零成本早退**判断）。
 *
 * 为什么必须粗估：精确口径要遍历活动块正文，而那是 context 层的事（本层不得 import `src/context/**`）。
 * 记忆注入是"越接近满额越该停"的语义，粗估**偏小**（真实单条约 60~120 token，这里按 48 计）
 * ⇒ 只会让早退稍晚发生，不会造成超注：真正的硬上界由 `injection_writer.ts` 的三层额度兜底。
 */
export const MEMORY_INJECT_AVG_ITEM_TOKENS = 48;

export type InjectKind = 'mental_model' | 'observation' | 'fact';

/** 一条记忆候选（`line` 创建后不可变：它是 `r` 的唯一输入） */
export interface InjectCandidate {
    bankId: string;
    kind: InjectKind;
    id: string;
    /** 冻结行文本（含 `[mem:<id>]` 句柄、已截断、自包含） */
    line: string;
    /**
     * 内容版本：`fnv1a32(冻结行).toString(36)`（r2 §2.1：比 `updatedAt` 更精确）。
     *
     * 当前 provider 侧的 `k` 拒发用不上它（框架按 `k + r` 判定，`r` 由 `makeItem` 从正文重算），
     * 保留它是为了 `MemoryService.planInjection()`（D5 完整版）直接把候选当账本视图用。
     */
    rev: string;
    /** 正文指纹：跨 bank 同文本去重（r2 §2.1） */
    textKey: string;
    /** bank 出现顺序（0 = 当前会话 bank；越大越靠后） */
    bankOrder: number;
    /** bank 内顺序（0 起） */
    itemOrder: number;
}

/** 增量选择结果 */
export interface InjectSelection {
    picked: InjectCandidate[];
    /** 选中条目的 token 合计（= Σ estimate(line)） */
    tokens: number;
    /** 因预算不足没进的条目数（不碎片化，整条留到下轮） */
    skippedBudget: number;
    /** 因同批正文重复被跳过的条目数（跨 bank 同文本） */
    skippedDup: number;
}

/** 记忆条目的去重键：`<bankId>|<kind>|<id>`（与 `prompt/injections/keys.memoryItemKey` 同构） */
export function injectKey(candidate: { bankId: string; kind: string; id: string }): string {
    return `${candidate.bankId}|${candidate.kind}|${candidate.id}`;
}

/** 是否是记忆条目的去重键（只数记忆条目，别把块头/分组标题算进去） */
export function isMemoryItemKey(key: string): boolean {
    return /^(?:user|group|global)_[^|]*\|(?:mental_model|observation|fact)\|[^|]+$/.test(String(key || ''));
}

/** 活动记忆条目数（只数记忆条目） */
export function countActiveMemoryItems(activeKeys: ReadonlySet<string>): number {
    let count = 0;
    activeKeys.forEach(key => {
        if (isMemoryItemKey(key)) count++;
    });
    return count;
}

/** 活动记忆条目 → token 粗估（零成本早退用，见 MEMORY_INJECT_AVG_ITEM_TOKENS） */
export function estimateActiveMemoryTokens(activeKeys: ReadonlySet<string>): number {
    return countActiveMemoryItems(activeKeys) * MEMORY_INJECT_AVG_ITEM_TOKENS;
}

/**
 * 本轮可用余量（唯一入口，r2 §2.3）。
 *
 * - 活动块为空（首次 / 归档释放后）：`min(MEMORY_PROMPT_TOKENS, WINDOW)`，默认 2048；
 * - 稳态：`min(DELTA, WINDOW − activeTokens)`，可为负（= 已满，本轮不注）。
 */
export function computeInjectRoom(
    activeTokens: number,
    memoryPromptTokens: number = DEFAULT_MEMORY_PROMPT_TOKENS,
): number {
    const active = Number.isFinite(activeTokens) ? Math.max(0, Math.floor(activeTokens)) : 0;
    if (active === 0) {
        const budget = Number.isFinite(memoryPromptTokens) && memoryPromptTokens > 0
            ? Math.floor(memoryPromptTokens)
            : DEFAULT_MEMORY_PROMPT_TOKENS;
        return Math.min(budget, MEMORY_INJECT_WINDOW);
    }
    return Math.min(MEMORY_INJECT_DELTA, MEMORY_INJECT_WINDOW - active);
}

/** base36 的 32 位哈希（rev / textKey 共用） */
function hash36(text: string): string {
    return fnv1a32(text).toString(36);
}

/** 跨 bank 同文本去重用的规范化（与 `prompt/injections/keys.normalizeForHash` 同口径） */
function normalizeForHash(text: string): string {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 单行化 + 截断（只在候选创建时执行一次） */
function freezeBody(text: string): string {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > MEMORY_INJECT_MAX_ITEM_CHARS
        ? `${value.slice(0, MEMORY_INJECT_MAX_ITEM_CHARS - 1)}…`
        : value;
}

/**
 * 冻结行：`- [mem:<id>] <正文>`（所有 kind 统一单行，便于去重与稳定 `r`）。
 *
 * 简化说明：r2 §2.2 让心智模型不带 bullet 且保留 `问\n答` 两行；本实现统一成单行 bullet，
 * **理由**：单行正文才能让"同一 `k` 的 `r` 只随内容变化"，多行会让空白/换行差异污染哈希。
 */
export function renderInjectLine(id: string, body: string): string {
    const frozen = freezeBody(body);
    const ref = String(id || '').trim();
    return ref ? `- [mem:${ref}] ${frozen}` : `- ${frozen}`;
}

// ---------------------------------------------------------------------------
// 渲染文本 → 候选
// ---------------------------------------------------------------------------

interface ParseState {
    /** 当前段所属 bank；`''` = 还没定（既无 scopeLabel 又不是 global 段） */
    bankId: string;
    current: { kind: InjectKind; id: string; body: string[] } | null;
    bankOrder: Map<string, number>;
    itemOrder: Map<string, number>;
    out: InjectCandidate[];
}

function flushCandidate(state: ParseState): void {
    const current = state.current;
    state.current = null;
    if (!current) return;
    const body = current.body.join(' ').trim();
    if (!body) return;
    const bankId = state.bankId;
    if (!bankId) return;                   // 段没定 bank：宁可少注，也不把条目记到错误的 bank 上
    if (!state.bankOrder.has(bankId)) state.bankOrder.set(bankId, state.bankOrder.size);
    const itemOrder = state.itemOrder.get(bankId) || 0;
    state.itemOrder.set(bankId, itemOrder + 1);
    const line = renderInjectLine(current.id, body);
    state.out.push({
        bankId,
        kind: current.kind,
        id: current.id,
        line,
        rev: hash36(line),
        textKey: hash36(normalizeForHash(body)),
        bankOrder: state.bankOrder.get(bankId) as number,
        itemOrder,
    });
}

/**
 * 候选解析：输入是 `MemoryService.buildMemoryPrompt`（`v2/prompt.buildMemoryPrompt`）渲染出的整段文本。
 *
 * TODO(#163 D5 完整版)：文本回解析是**过渡实现**。正解是在 `MemoryService` 内新增
 * `planInjection()`（r2 §2.4），把 `collectSections()` 的心智模型 / 观察 / 召回结果直接产出
 * `InjectCandidate[]`，不再经过字符串。之所以现在这么做：`src/memory/service.ts` 不在本 PR 的
 * 写入边界内（与其他 teammate 并行改动会冲突），而这里解析的格式是**本仓库自己的渲染器**产出的，
 * 且解析失败只会少注（不会注错）。
 *
 * 解析规则（与 `v2/prompt.buildMemoryPrompt` 一一对应）：
 * - `## <title>` 开新段：标题含 `global` ⇒ 该段属 global bank；否则等 scopeLabel 定 bank；
 * - `Group: <sid>` / `Personal: <uid>` = 渲染器的 scopeLabel，给当前段定 bank；
 * - `[mem:<id>] <正文>` 心智模型；`- [mem:<id>]` 观察；`<n>. [mem:<id>]` 事实；
 * - 其余行算上一条的续行。
 */
export function parseMemoryPromptCandidates(
    text: string,
    opts: { globalBankId?: string } = {},
): InjectCandidate[] {
    const globalBankId = opts.globalBankId || 'global_main';
    const state: ParseState = {
        bankId: '',
        current: null,
        bankOrder: new Map<string, number>(),
        itemOrder: new Map<string, number>(),
        out: [],
    };
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        // 不用 trimEnd（ES2019，target es2017 与 Goja 运行时都没有）
        const line = rawLine.replace(/\s+$/, '');
        if (!line.trim()) continue;
        if (/^##\s+/.test(line)) {
            flushCandidate(state);
            state.bankId = /global/i.test(line) ? globalBankId : '';
            continue;
        }
        const scope = /^(Group|Personal):\s*(.+)$/.exec(line);
        if (scope) {
            flushCandidate(state);
            state.bankId = scope[1] === 'Group' ? `group_${scope[2].trim()}` : `user_${scope[2].trim()}`;
            continue;
        }
        const item = /^(?:(- )|(\d+)\.\s*)?\[mem:([^\]\s]+)\]\s*(.*)$/.exec(line);
        if (item) {
            flushCandidate(state);
            const kind: InjectKind = item[1] ? 'observation' : item[2] ? 'fact' : 'mental_model';
            state.current = { kind, id: item[3], body: [item[4] || ''] };
            continue;
        }
        if (state.current) state.current.body.push(line);
    }
    flushCandidate(state);
    return state.out;
}

/**
 * 增量选择（r2 §2.4 `selectInjectDelta` 的简化版）。
 *
 * 已注入（`k ∈ activeKeys`）的条目直接跳过：provider 侧拒发，避免每轮都产出同样的条目
 * 走一遍框架去重。预算不够时**整条留到下一轮**（绝不截断正文：截断会让同一 `k` 的 `r` 抖动
 * ⇒ 下一轮判 `updated` ⇒ 无限重写，d3b G.2）。
 *
 * 唯一的例外与 `injection_writer.clampToPerTurnBudget` 同口径：**第一条**自身超余量时单独放行，
 * 否则一条超长记忆会把整个记忆注入永久饿死。
 */
export function selectInjectCandidates(
    candidates: readonly InjectCandidate[],
    activeKeys: ReadonlySet<string>,
    room: number,
    estimate: (text: string) => number,
): InjectSelection {
    const picked: InjectCandidate[] = [];
    const seenText = new Set<string>();
    let used = 0;
    let skippedBudget = 0;
    let skippedDup = 0;
    for (const candidate of candidates) {
        if (activeKeys.has(injectKey(candidate))) continue;
        // 同批跨 bank 同文本（群 bank 与 global bank 同一条事实）：只注第一条
        if (seenText.has(candidate.textKey)) {
            skippedDup++;
            continue;
        }
        const cost = Math.max(1, estimate(candidate.line));
        if (used > 0 && used + cost > room) {
            skippedBudget++;
            break;
        }
        used += cost;
        seenText.add(candidate.textKey);
        picked.push(candidate);
        if (used >= room) break;
    }
    return { picked, tokens: used, skippedBudget, skippedDup };
}
