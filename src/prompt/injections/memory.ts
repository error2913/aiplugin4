// `kind:'memory'` 内置注入 provider（#163 D3 / D5）。
//
// 语义（r2-memory-time.md §2.2~§2.4）：
// 1. 粒度：**一条记忆一个条目**，去重键 `<bankId>|<kind>|<id>`；正文变化时框架按 `r` 判 `updated`
//    并自动加 `(updated)` 标记（本 provider 不自己判更正、不改已写块）；
// 2. 预算三值（不可配置成别的数）：窗口 4096 / 单轮 512 / 最小余量 24；
// 3. **零成本稳态**：`room < 24` 时**先返回空**，绝不触达 `getPromptMemorySource()`
//    —— 它是 recall / 嵌入 / bank 写盘的唯一入口，碰了就是每轮 CPU + 最多 5 次写盘；
// 4. 按 `k` 拒发：`k ∈ c.listActiveKeys()` 的条目不再产出（否则每轮都要走一遍全量构建）；
// 5. 正文**禁止绝对时间**（REQ-D4-07，唯一例外是 `core:time`）：条目正文只用记忆自身的文本。
//
// 块结构（块头 / bank 分组标题 / 块尾 guard）为什么也是条目：
// 框架把「同一 kind 的 items 用 `\n` 拼成块正文」再包 `[system:inject-memory] [/system]`，
// provider 拿不到"块级前缀/后缀"这个表达位。所以三类结构文本各自作为**稳定 key 的条目**产出：
// 窗口内第一次注入时写一次（`k` 进活动块后本 provider 自动不再产出），稳态零开销。
// 已知简化：同一窗口内的**后续增量块**不再重复块头/块尾（靠 `[system:inject-memory]` 标签自识别）。
// 完整做法需要框架侧支持 draft 级 prefix/suffix，或在 `MemoryService` 内直出块文本（D5 完整版）。
import Config from "../../config/config";
import type { InjectionItem } from "../../context/injections";
import { bankKindOfBankId, resolveGlobalBank } from "../../memory/v2/bank_resolver";
import {
    computeInjectRoom,
    estimateActiveMemoryTokens,
    MEMORY_INJECT_MIN_ROOM,
    parseMemoryPromptCandidates,
    selectInjectCandidates,
} from "../../memory/v2/inject";
import { DEFAULT_MEMORY_PROMPT_TOKENS } from "../../memory/v2/prompt";
import { getPromptMemorySource } from "../memory_source";
import { MEMORY_INJECT_BANK, MEMORY_INJECT_HEADING, MEMORY_INJECT_TAIL } from "../texts/en";
import type { InjectionContext, InjectionProvider } from "../types";

import { makeItem, memoryItemKey } from "./keys";

/** 结构条目的活动键（不是记忆条目：`isMemoryItemKey` 不匹配，因此不计入 active token 粗估） */
const KEY_HEADING = 'memory:heading';
const KEY_TAIL = 'memory:tail';
/** `memory:bank:<bankId>` 前缀 */
const KEY_BANK_PREFIX = 'memory:bank:';
/** bank 分组标题的 token 预留（通常 3 个 bank，每个 ~6 token） */
const BANK_HEADING_RESERVE = 16;

/**
 * 首轮预算（配置「记忆注入 token 预算」）。
 *
 * r2 §2.3 语义：首次 / 归档后取 `min(MEMORY_PROMPT_TOKENS, WINDOW)`。
 * 配置分区是 `Object.defineProperty` 惰性定义的，未注册（单测 / 首启前）时访问会抛错 ⇒ 兜底出厂默认。
 */
function readMemoryPromptTokens(): number {
    try {
        const value = Number(Config.memory.MEMORY_PROMPT_TOKENS);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_MEMORY_PROMPT_TOKENS;
    } catch {
        return DEFAULT_MEMORY_PROMPT_TOKENS;
    }
}

/** bankId → 稳定 sid（`group_QQ-Group:1` → `QQ-Group:1`）：标题不显示可变的群名/昵称 */
function rawIdOf(bankId: string): string {
    return String(bankId || '').replace(/^(?:user|group|global)_/, '');
}

/** bank 分组标题：`### Group: <sid>` / `### Personal: <uid>` / `### Self experience (global)` */
function bankHeading(bankId: string): string {
    const kind = bankKindOfBankId(bankId);
    if (kind === 'group') return MEMORY_INJECT_BANK.group(rawIdOf(bankId));
    if (kind === 'user') return MEMORY_INJECT_BANK.personal(rawIdOf(bankId));
    return MEMORY_INJECT_BANK.global;
}

/** 构造 memory provider（order 200：同 anchor 的渲染顺序 time → memory → mcp） */
export function createMemoryProvider(): InjectionProvider {
    return {
        name: 'core:memory',
        kind: 'memory',
        order: 200,
        // 记忆是背景信息：数据源不可用 / 抛错都不该让整轮请求失败
        optional: true,
        async build(c: InjectionContext): Promise<InjectionItem[]> {
            // 「启用长期记忆」关闭 ⇒ 零成本（不碰数据源、不算预算）
            if (!c.flags.memory) return [];

            const activeKeys = c.listActiveKeys();
            const activeTokens = estimateActiveMemoryTokens(activeKeys);
            const room = computeInjectRoom(activeTokens, readMemoryPromptTokens());
            // ★ 零成本稳态：余量不足时**先**返回；`getPromptMemorySource()` 及其后的
            //    recall / 嵌入 / 写 bank 一次都不会发生（r2 §2.3 硬语义 2）
            if (room < MEMORY_INJECT_MIN_ROOM) return [];

            // 结构条目本窗口还没写过才预留它们的 token（避免首轮刚好把条目顶出 per-turn 额度）
            const structureReserve =
                (activeKeys.has(KEY_HEADING) ? 0 : c.estimateTokens(MEMORY_INJECT_HEADING))
                + (activeKeys.has(KEY_TAIL) ? 0 : c.estimateTokens(MEMORY_INJECT_TAIL))
                + BANK_HEADING_RESERVE;
            const selectRoom = Math.max(0, room - structureReserve);

            const source = getPromptMemorySource();
            const text = await source.buildLongTermPrompt(c.ctx, c.session, c.query, c.users, c.group);
            if (!text || !text.trim()) return [];

            const candidates = parseMemoryPromptCandidates(text, {
                globalBankId: resolveGlobalBank(c.session.agentName).bankId,
            });
            if (candidates.length === 0) return [];

            const selection = selectInjectCandidates(candidates, activeKeys, selectRoom, c.estimateTokens);
            if (selection.picked.length === 0) return [];

            const items: InjectionItem[] = [];
            const pushStructure = (key: string, body: string): void => {
                if (activeKeys.has(key)) return;
                items.push(makeItem(key, body));
            };
            pushStructure(KEY_HEADING, MEMORY_INJECT_HEADING);
            let lastBank = '';
            for (const picked of selection.picked) {
                if (picked.bankId !== lastBank) {
                    lastBank = picked.bankId;
                    pushStructure(`${KEY_BANK_PREFIX}${picked.bankId}`, bankHeading(picked.bankId));
                }
                items.push(makeItem(
                    memoryItemKey(picked.bankId, picked.kind, picked.id),
                    picked.line,
                ));
            }
            pushStructure(KEY_TAIL, MEMORY_INJECT_TAIL);
            return items;
        },
    };
}
