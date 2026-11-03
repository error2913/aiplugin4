// 归档控制器的会话级工厂（v7 单一路径；v6 CompactionRuntime 已删除）。
//
// 为什么必须共享：自动路径与手动 `.ai ctx archive` 若各 new 一个控制器，
// 两个「单飞」互不可见，可同时对同一批未摘要事件执行摘要 → 重复摘要/重复计费。
//
// 这里是「归档 = 滚动摘要 + 记忆抽取」的接线点：
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
import { COMPACT_BATCH_TOKENS, SUMMARY_MAX_CHARS } from "../../utils/context_limits";
import { parseJsonLoose } from "../../utils/json";
import {
    estimateEventTokens as estimateEventTokensShared,
    estimateTextTokens,
} from "../../utils/token_estimate";
import { ArchiveController } from "../archive_controller";
import type { ConversationEvent } from "../events";
import type { ContextService } from "../service";

import { buildArchivePrompt } from "./archive_prompt";
import type { ArchiveDraft } from "./compactor";

interface CachedController {
    service: ContextService;
    controller: ArchiveController;
}

const controllers = new WeakMap<object, CachedController>();
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

/** 每会话的归档相关固定信息（scope 文案 / facts 开关 / 草稿存取）。 */
function archiveContextFor(session: Session) {
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
    return { sessionId, scopeLine, flags, draftStore };
}

/** 摘要 / facts / 草稿的公共端口（归档控制器唯一入口）。 */
function buildArchivePorts(session: Session, sessionId: string, scopeLine: string, flags: { extract: boolean; global: boolean }, draftStore: {
    load(): ArchiveDraft | null;
    save(draft: ArchiveDraft): void;
    clear(): void;
}) {
    return {
        // 合并路径：摘要 + facts 同一请求
        summarizeAndExtract: async ({ previousSummary, segmentText }: { previousSummary: string; segmentText: string }) => {
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
        // facts 写库（摘要提交后）：失败抛错 → 草稿保留，下次归档入口重放
        applyFacts: async (facts: unknown[], info: { epoch: number; fromSeq: number; toSeq: number }) => {
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
        saveArchiveDraft: (draft: ArchiveDraft) => draftStore.save(draft),
        clearArchiveDraft: () => draftStore.clear(),
        estimateEventTokens,
    };
}

/** 取会话共享的归档控制器（双水位 + 标记块 + 单飞）；未接入事件账本返回 null。 */
export function archiveControllerFor(session: Session): ArchiveController | null {
    const service = session.contextV2;
    if (!service) return null;
    const cached = controllers.get(session);
    if (cached && cached.service === service) return cached.controller;

    const { sessionId, scopeLine, flags, draftStore } = archiveContextFor(session);
    const controller = new ArchiveController({
        service,
        ...buildArchivePorts(session, sessionId, scopeLine, flags, draftStore),
        estimateTextTokens,
        batchTokens: COMPACT_BATCH_TOKENS,
        summaryMaxChars: SUMMARY_MAX_CHARS,
        log: (message, error) => {
            if (error === undefined) log.warning(message);
            else log.warning(`${message}: ${error instanceof Error ? error.message : String(error)}`);
        },
    });
    controllers.set(session, { service, controller });
    return controller;
}

/** 测试/热重载用：丢弃某会话的缓存（下一轮按当前 contextV2 重建）。 */
export function resetArchiveController(session: object): void {
    controllers.delete(session);
}
