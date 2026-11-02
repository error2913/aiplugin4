// 上下文 → 记忆的桥已下线（P0-4）：记忆抽取并入「归档」合并请求，由
// context/compact/session_runtime 的 summarizeAndExtract/applyFacts 完成。
//
// 本文件只保留「触发一次归档」的入口，供 agent 的 run 结束钩子调用。
import { compactionRuntimeFor } from "../context/compact/session_runtime";
import type { Session } from "../session/session";

/**
 * 后台滚动摘要（自动路径）：由 run 结束钩子触发；runtime 按会话共享（与手动 archive 同一单飞）。
 * 返回 null 表示会话未接入事件账本。
 */
export async function compactContextV2(
    session: Session,
    targetTokens: number,
): Promise<{ advanced: boolean; reason?: string; batches?: number } | null> {
    const runtime = compactionRuntimeFor(session);
    if (!runtime) return null;
    const result = await runtime.maybeRun(targetTokens);
    return { advanced: result.advanced, reason: result.reason, batches: result.batches };
}
