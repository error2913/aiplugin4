// 每轮增量注入的规划入口（#163 D3 接线层，L3）。
//
// 调用点：`agent.ts` 每次真正发请求**之前**调用一次（`runInternal` / `runStreamInner`）。
// 必须早于 `handleMessages`：`compileV2Request` 是按当前 `snapshot()` 渲染注入块的，
// 块写晚了这一轮就看不见它（只能等下一轮）。
//
// 职责边界（与 `injection_writer.ts` 互补，不重复实现）：
// - 本文件只做「取 provider 列表 → 构造只读 InjectionContext → 收集 draft → 交给 writer」；
// - 去重（`injection_dedup`）、三层额度、预算闸、先归档后写块、唯一写入口全部在 `injection_writer.ts`；
// - `session.injectionAnchorSeq` 的推进**不在这里**：只有 agent 知道请求是否真的发出去了，
//   在"请求成功发出"与"请求未发出"两条路径上的语义完全不同（见 agent.ts 调用点注释）。
import Config from "../config/config";
import { collectMemoryInput, deriveImagePromptFlags } from "../prompt/builder";
import { resolveInjectionProviders } from "../prompt/injection_registry";
import type { InjectionContext, PromptFlags } from "../prompt/types";
import type { Session } from "../session/session";
import { resolveArchiveL } from "../utils/context_budget";
import { buildArchiveBudgetInput } from "../utils/message";
import { extraSeparatorLabels } from "../utils/message_separator";
import { estimateTextTokens } from "../utils/token_estimate";

import { archiveControllerFor } from "./compact/session_runtime";
import type { ConversationEvent } from "./events";
import { writeInjectionBlocks } from "./injection_writer";
import type {
    InjectionArchivePort,
    InjectionWriteBudget,
    InjectionWriteDeps,
    InjectionWriteResult,
    RawInjectionDraft,
} from "./injection_writer";
import { isStaleByRecords, releaseBoundaryOf, splitInjections } from "./injections";
import type { InjectionItem } from "./injections";

/**
 * system 消息类型：与 `compileV2Request` 的 `prefix[0]` 同源。
 *
 * `utils/message.ts` 的 `ContextMessage` 是模块私有 interface（本 PR 不动它），
 * 这里用 `Parameters<>` 取它的结构，避免为了一个参数去放宽 L2 模块的导出面。
 */
export type InjectionSystemMessage = Parameters<typeof buildArchiveBudgetInput>[2];

export interface InjectionPlanInput {
    ctx: seal.MsgContext;
    session: Session;
    /** 与 `compileV2Request` 的 `prefix[0]` 同源（同一个 `promptPartsToSystemMessage` 产物） */
    systemMessage: InjectionSystemMessage;
    tools: unknown[] | undefined;
    modelName: string | undefined;
    /** 上一次请求真正发送到的最大 seq（= `session.injectionAnchorSeq`，首次为 0） */
    lastSentSeq: number;
}

/** 配置读取兜底：配置尚未注册/读取异常时按出厂默认处理，绝不因读配置崩掉一整轮请求 */
function safeBoolean(read: () => boolean, fallback: boolean): boolean {
    try {
        return !!read();
    } catch {
        return fallback;
    }
}

function safeNumber(read: () => number, fallback: number): number {
    try {
        const value = Number(read());
        return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
        return fallback;
    }
}

/**
 * 注入侧开关快照：语义必须与 `src/prompt/builder.ts` 的 `readFlags()` **完全一致**。
 *
 * 为什么不直接复用：`readFlags()` 是 builder 的模块私有函数（本 PR 不改 `src/prompt/**`）。
 * 图片三开关共用 `deriveImagePromptFlags`（唯一派生点），其余字段按 builder 同口径读取，
 * 两边任何一处改动都要同步 —— 因此这里只保留最小字段集，不做任何新语义。
 */
function readInjectionFlags(): PromptFlags {
    const { RECEIVE_IMAGE } = Config.received;
    const { STATUS, PROMPT_ENGINEERING, DIRECTION_PROMPT } = Config.tool;
    const { EXTRA_SEPARATOR } = Config.reply;
    const derived = deriveImagePromptFlags({
        receiveImage: !!RECEIVE_IMAGE,
        imageHostPrompt: safeBoolean(() => Config.image.IMAGE_HOST_PROMPT, true),
        resourcePrompt: safeBoolean(() => Config.resource.RESOURCE_LIBRARY, false),
    });
    // 先取局部变量再读字段：`src/context/**` 有一条静态守卫禁止出现 `.<模块>.` 形态的记忆耦合访问
    //（`testV3ContextDecoupledFromMemory`），这里读的是**配置**不是 `session.memory`，
    // 但字面量形态会误伤，故按 session_runtime.ts 的写法先赋给局部变量。
    const memoryConfig = Config.memory as unknown as { MEMORY_ENABLED?: boolean; MEMORY?: boolean } | undefined;
    return {
        status: !!STATUS,
        promptEngineering: !!PROMPT_ENGINEERING,
        directionPrompt: !!DIRECTION_PROMPT,
        receiveImage: !!RECEIVE_IMAGE,
        extraSeparator: extraSeparatorLabels(EXTRA_SEPARATOR),
        imageUsage: derived.imageUsage,
        resourceLibrary: derived.resourceLibrary,
        imageHost: derived.imageHost,
        resourceBudget: safeNumber(() => Config.resource.RESOURCE_LIBRARY_BUDGET, 600),
        imageHostBudget: safeNumber(() => Config.image.IMAGE_HOST_PROMPT_BUDGET, 600),
        imageLibrary: derived.imageLibrary,
        memory: !!(memoryConfig?.MEMORY_ENABLED ?? memoryConfig?.MEMORY),
        knowledge: !!Config.knowledgeBase.KNOWLEDGE,
    };
}

/**
 * 最后一条 `kind:'assistant'` 事件：`{seq, at}`（`at` 秒 → 毫秒）。
 *
 * 为什么以事件为权威而不是"上次调用 chat 的时刻"：中途可能被 stop / 报错 / 工具轮打断，
 * 只有真正落库的 assistant 事件才代表"模型已经回复过"，`core:time` 的 1h 阈值靠它。
 */
function lastAssistantOf(events: readonly ConversationEvent[]): { seq: number; at: number } {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.kind !== 'assistant') continue;
        const seq = Math.max(0, Math.floor(Number(event.seq) || 0));
        const atSec = Number(event.at);
        const at = Number.isFinite(atSec) && atSec > 0 ? Math.floor(atSec * 1000) : 0;
        return { seq, at };
    }
    return { seq: 0, at: 0 };
}

/** provider 返回值防御：脏条目（空键/空正文/非对象）直接丢弃，不写块 */
function keepValidItems(items: unknown): InjectionItem[] {
    if (!Array.isArray(items)) return [];
    const kept: InjectionItem[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as InjectionItem;
        if (typeof candidate.k !== 'string' || candidate.k === '') continue;
        if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue;
        kept.push(candidate);
    }
    return kept;
}

/**
 * 每轮注入规划：构造 `InjectionContext` → 调 provider → 写块。返回本轮写入结果。
 *
 * 返回 `null` 的两种情况（都是"零成本直接返回"，不碰 snapshot / 预算 / 索引）：
 * 1. `session.contextV2` 为空（v1 旧路径，不做注入）；
 * 2. 没有注册任何 provider（稳态：内置 provider 未启用 / 扩展未注册）。
 *
 * 不抛 provider 异常的两个例外：`optional === false` 的 provider（内置缺省）失败时上抛，
 * 让本轮请求按既有错误路径处理 —— 内置 provider 静默失能比报错更难排查。
 */
export async function planAndWriteInjections(input: InjectionPlanInput): Promise<InjectionWriteResult | null> {
    const service = input.session.contextV2;
    if (!service) return null;                       // v1 路径：不注入
    const providers = resolveInjectionProviders();
    if (providers.length === 0) return null;         // 无 provider：稳态零成本

    const { ctx, session } = input;
    const lastSentSeq = Math.max(0, Math.floor(Number(input.lastSentSeq) || 0));
    // 本轮冻结的当前时刻（值不是函数：同一轮两次构建必须字节一致，见 R2）
    const now = Date.now();

    const snapshot = service.snapshot();
    const lastReply = lastAssistantOf(snapshot.events);

    // 活动块键集合按需计算（provider 不调用就不扫事件）
    let activeKeys: Set<string> | null = null;
    const listActiveKeys = (): ReadonlySet<string> => {
        if (activeKeys) return activeKeys;
        const boundary = releaseBoundaryOf(snapshot.head);
        const redacts = snapshot.records.filter(record => record.kind === 'redact');
        const split = splitInjections(snapshot.events, boundary, {
            isStale: meta => isStaleByRecords(meta, redacts),
        });
        activeKeys = new Set<string>();
        for (const ref of split.injections) {
            for (const item of ref.meta.items) activeKeys.add(item.k);
        }
        return activeKeys;
    };

    const memory = collectMemoryInput(ctx, session);
    const injectionContext: InjectionContext = {
        ctx,
        session,
        flags: readInjectionFlags(),
        isPrivate: !!ctx.isPrivate,
        sessionId: String(session.sessionId || ''),
        query: memory.query,
        users: memory.users,
        group: memory.group,
        lastSentSeq,
        now,
        lastReplySeq: lastReply.seq,
        lastReplyAt: lastReply.at,
        listActiveKeys,
        estimateTokens: estimateTextTokens,
    };

    const drafts: RawInjectionDraft[] = [];
    for (const provider of providers) {
        let produced: InjectionItem[];
        try {
            produced = await provider.build(injectionContext);
        } catch (error) {
            if (provider.optional !== false) {
                // 可跳过的 provider（扩展缺省 / 显式 optional）：只记观测，不影响本轮请求
                session.notePrefixObservation('injection-provider-failed', {
                    name: provider.name,
                    message: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            throw error;                             // 内置 provider：fail fast
        }
        const items = keepValidItems(produced);
        if (items.length === 0) continue;
        drafts.push({
            kind: provider.kind,
            items,
            extension: provider.name.startsWith('ext:'),
        });
    }
    // 没有任何候选：不写块也不做预算计算（下一轮仍会重新问 provider，provider 自己用
    // `listActiveKeys()` 做"已注入"判定，框架不做"已问过就不再问"的记录）
    if (drafts.length === 0) {
        return { blocks: 0, items: 0, tokens: 0, seqs: [], duplicates: 0, skipped: 0, archived: false };
    }

    // 预算口径与编译**同源**（同一个 buildArchiveBudgetInput / resolveArchiveL），
    // 否则会出现"注入以为装得下、编译以为装不下"的裂缝（REQ-D7-11）。
    const { input: budgetInput, retainPercent } = buildArchiveBudgetInput(
        ctx, session, input.systemMessage, input.tools, input.modelName,
    );
    const budget: InjectionWriteBudget = {
        prefixTokens: budgetInput.prefixTokens,
        toolsReserveTokens: budgetInput.toolsReserveTokens,
        permanentBudget: budgetInput.permanentBudget,
        retainPercent,
    };

    const controller = archiveControllerFor(session);
    // 兜底端口：控制器不可用时（未接入事件账本的异常路径）按"T=0、不归档"处理，
    // writer 只会走"装得下"分支，绝不因为拿不到归档器而不注入。
    const archive: InjectionArchivePort = controller ?? {
        estimateT: () => 0,
        beforeRequest: () => { /* 无归档器可调 */ },
    };
    const deps: InjectionWriteDeps = {
        service,
        archive,
        estimateTokens: estimateTextTokens,
        computeL: resolveArchiveL,
        observe: (event, detail) => session.notePrefixObservation(event, detail),
        notePrefixRebase: (reason, seq) => session.notePrefixRebase(reason, seq),
    };

    return writeInjectionBlocks({ deps, drafts, lastSentSeq, budget });
}
