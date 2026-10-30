// 压缩运行时的共享工厂：按会话复用**同一个** CompactionRuntime。
//
// 为什么必须共享：自动路径（run 结束钩子）与手动 `.ai ctx archive` 若各 new 一个 runtime，
// 两个「单飞」互不可见，可同时对同一批未摘要事件执行 compactOnce → 重复摘要/重复计费，
// 违反「每会话 epoch 最多一条滚动摘要」的语义。
//
// 分层：context 属 L3，只依赖 core/session/utils，不依赖 agent；本文件不 import 任何 agent 模块。
import { getAuxLlm } from "../../core/ports/aux_llm";
import type { Session } from "../../session/session";
import { COMPACT_BATCH_TOKENS, COMPACT_MAX_BATCHES_PER_RUN, SUMMARY_MAX_CHARS } from "../../utils/context_limits";
import { estimateEventTokens as estimateEventTokensShared } from "../../utils/token_estimate";
import type { ConversationEvent } from "../events";
import type { ContextService } from "../service";

import { CompactionRuntime } from "./runtime";

interface CachedRuntime {
    /** runtime 绑定的上下文门面：purge 后 service 被替换，需重建（单飞状态不跨 epoch 复用） */
    service: ContextService;
    runtime: CompactionRuntime;
}

const runtimes = new WeakMap<object, CachedRuntime>();

/**
 * 事件 token 估算：与事件账本/编译/请求告警同口径（文本走 `estimateTextTokens`）。
 * 历史 chars/3 对中文低估约 3 倍，会让摘要目标量跟着漂移；统一到共享 helper。
 */
export function estimateEventTokens(event: ConversationEvent): number {
    return estimateEventTokensShared(event);
}

/**
 * 取会话共享的压缩运行时；未接入事件账本（contextV2 为 null）返回 null。
 * 自动路径与命令层必须都走这里，保证单飞与退避状态一致。
 */
export function compactionRuntimeFor(session: Session): CompactionRuntime | null {
    const service = session.contextV2;
    if (!service) return null;
    const cached = runtimes.get(session);
    if (cached && cached.service === service) return cached.runtime;
    const runtime = new CompactionRuntime(
        {
            batchTokens: COMPACT_BATCH_TOKENS,
            summaryMaxChars: SUMMARY_MAX_CHARS,
            maxBatchesPerRun: COMPACT_MAX_BATCHES_PER_RUN,
        },
        {
            service,
            summarize: async (text: string) => {
                try {
                    const out = await getAuxLlm().chat('summarize_agent', text);
                    return typeof out === 'string' && out.trim() ? out : null;
                } catch {
                    return null;
                }
            },
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
