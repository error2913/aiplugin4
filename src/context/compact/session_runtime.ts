// 压缩运行时的共享工厂：按会话复用**同一个** CompactionRuntime。
//
// 为什么必须共享：自动路径（run 结束钩子）与手动 `.ai ctx archive` 若各 new 一个 runtime，
// 两个「单飞」互不可见，可同时对同一批未摘要事件执行 compactOnce → 重复摘要/重复计费，
// 违反「每会话 epoch 最多一条滚动摘要」的语义。
//
// P0-4 起，这里是「归档 = 滚动摘要 + 记忆抽取」的接线点：
// - summarizeAndExtract：一次 LLM 调用产出 {summary, facts}（archive_prompt）；
// - applyFacts：通过 L0 端口把 facts 交给记忆层（context 不 import memory）；
// - load/save/clearArchiveDraft：两阶段草稿，facts 写失败/进程崩溃后重放同一 payload。
import Config from "../../config/config";
import { getHost } from "../../core/host";
import { getArchiveFactsSink } from "../../core/ports/archive_facts";
import { getAuxLlm } from "../../core/ports/aux_llm";
import { logger } from "../../logger";
import { classifyAuxError, isClassifiedApiError } from "../../model/api_error";
import { isAuxPaused, noteFatalAuxError } from "../../model/aux_breaker";
import type { Session } from "../../session/session";
import { COMPACT_BATCH_TOKENS, COMPACT_MAX_BATCHES_PER_RUN, SUMMARY_MAX_CHARS } from "../../utils/context_limits";
import { parseJsonLoose } from "../../utils/json";
import { estimateEventTokens as estimateEventTokensShared } from "../../utils/token_estimate";
import type { ConversationEvent } from "../events";
import type { ContextService } from "../service";

import { buildArchivePrompt } from "./archive_prompt";
import type { ArchiveDraft } from "./compactor";
import { CompactionRuntime } from "./runtime";

interface CachedRuntime {
    /** runtime 绑定的上下文门面：purge 后 service 被替换，需重建（单飞状态不跨 epoch 复用） */
    service: ContextService;
    runtime: CompactionRuntime;
}

const runtimes = new WeakMap<object, CachedRuntime>();
const log = logger.withTag('ctx-archive');

/**
 * 事件 token 估算：与事件账本/编译/请求告警同口径（文本走 `estimateTextTokens`）。
 */
export function estimateEventTokens(event: ConversationEvent): number {
    return estimateEventTokensShared(event);
}

function archiveDraftKey(sessionId: string): string {
    return `archive_draft:${sessionId}`;
}

function memoryFlags(): { extract: boolean; global: boolean } {
    const memory = Config.memory as unknown as { MEMORY_ENABLED?: boolean; EXTRACT_ENABLED?: boolean; EXTRACT_GLOBAL?: boolean };
    return {
        extract: memory.MEMORY_ENABLED !== false && memory.EXTRACT_ENABLED !== false,
        global: memory.EXTRACT_GLOBAL === true,
    };
}

/** 记忆被清空时一并丢弃归档草稿，避免旧草稿重放把已删事实写回。 */
export function clearArchiveDraftForSession(sessionId: string): void {
    if (!sessionId) return;
    try { getHost().storage.set(archiveDraftKey(sessionId), ''); } catch { /* ignore */ }
}

/** 取会话共享的压缩运行时；未接入事件账本（contextV2 为 null）返回 null。 */
export function compactionRuntimeFor(session: Session): CompactionRuntime | null {
    const service = session.contextV2;
    if (!service) return null;
    const cached = runtimes.get(session);
    if (cached && cached.service === service) return cached.runtime;

    const sessionId = String(session.sessionId || '');
    const isPrivate = !/-Group:/.test(sessionId);
    const platform = sessionId.split(':')[0] || '';
    const rawId = sessionId.replace(/^.+:/, '');
    const scopeLine = `Conversation scope: platform=${platform}, ${isPrivate ? `private chat: ${rawId}` : `group chat: ${rawId}`}`;
    const flags = memoryFlags();

    const draftStore = {
        load(): ArchiveDraft | null {
            try {
                const raw = getHost().storage.get(archiveDraftKey(sessionId));
                if (!raw) return null;
                const parsed = JSON.parse(raw) as ArchiveDraft;
                return parsed && parsed.info && Array.isArray(parsed.facts) ? parsed : null;
            } catch {
                return null;
            }
        },
        save(draft: ArchiveDraft): void {
            try { getHost().storage.set(archiveDraftKey(sessionId), JSON.stringify(draft)); } catch { /* ignore */ }
        },
        clear(): void {
            try { getHost().storage.set(archiveDraftKey(sessionId), ''); } catch { /* ignore */ }
        },
    };

    const runtime = new CompactionRuntime(
        {
            batchTokens: COMPACT_BATCH_TOKENS,
            summaryMaxChars: SUMMARY_MAX_CHARS,
            maxBatchesPerRun: COMPACT_MAX_BATCHES_PER_RUN,
        },
        {
            service,
            // 纯摘要（兼容路径 / 未启用合并时）
            summarize: async (text: string) => {
                if (isAuxPaused()) return null;
                try {
                    const out = await getAuxLlm().chat('summarize_agent', text, { throwClassified: true });
                    return typeof out === 'string' && out.trim() ? out : null;
                } catch (e) {
                    if (isClassifiedApiError(e) && classifyAuxError(e.kind) === 'fatal') {
                        noteFatalAuxError(e.kind, e.message);
                    }
                    return null;
                }
            },
            // 合并路径：摘要 + facts 同一请求
            summarizeAndExtract: async ({ previousSummary, segmentText }) => {
                if (isAuxPaused()) return null;
                const prompt = buildArchivePrompt({
                    previousSummary,
                    segmentText,
                    scopeLine,
                    extractEnabled: flags.extract,
                });
                let reply: string;
                try {
                    reply = await getAuxLlm().chat('summarize_agent', prompt, { throwClassified: true });
                } catch (e) {
                    if (isClassifiedApiError(e) && classifyAuxError(e.kind) === 'fatal') {
                        noteFatalAuxError(e.kind, e.message);
                    }
                    return null;
                }
                const data = parseJsonLoose(reply);
                if (!data || typeof data.summary !== 'string' || !data.summary.trim()) return null;
                if (flags.extract && !Array.isArray(data.facts)) return null;
                return { summary: data.summary, facts: flags.extract ? data.facts : [] };
            },
            // facts 写库（摘要提交后）：失败抛错 → service 保留草稿，下次 compact 重放
            applyFacts: async (facts, info) => {
                if (!facts.length) return;
                const sink = getArchiveFactsSink();
                if (!sink) {
                    log.error('[archive] facts sink 未注册，本次 facts 未写库（草稿保留待重放）');
                    throw new Error('archive_facts_sink_missing');
                }
                await sink({
                    sessionId,
                    agentName: session.agentName,
                    facts,
                    epoch: info.epoch,
                    fromSeq: info.fromSeq,
                    toSeq: info.toSeq,
                });
            },
            loadArchiveDraft: () => draftStore.load(),
            saveArchiveDraft: draft => draftStore.save(draft),
            clearArchiveDraft: () => draftStore.clear(),
            estimateEventTokens,
        },
    );
    runtimes.set(session, { service, runtime });
    return runtime;
}

/** 测试/热重载用：丢弃某会话的缓存（下一轮按当前 contextV2 重建） */
export function resetCompactionRuntime(session: object): void {
    runtimes.delete(session);
}
