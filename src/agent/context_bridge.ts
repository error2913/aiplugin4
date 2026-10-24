// 记忆桥：从 Context v2 事件账本消费原文并沉淀长期记忆（上下文不再直接写记忆）。
// 消费水位由本桥维护（WeakMap，不进入上下文）；成功后推进，失败下次重试。
import Config from "../config/config";
import { CompactionRuntime } from "../context/compact/runtime";
import type { ConversationEvent } from "../context/events";
import { readRaw } from "../context/recall";
import { getAuxLlm } from "../core/ports/aux_llm";
import { MemoryManager } from "../memory/manager";
import type { Session } from "../session/session";

const cursors = new WeakMap<object, number>();
const compactions = new WeakMap<object, CompactionRuntime>();

function estimateEventTokens(event: ConversationEvent): number {
    const parts = (event as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
    let chars = 0;
    for (const part of parts) if (part.type === 'text') chars += String(part.text ?? '').length;
    if (event.kind === 'tool_call') chars += String(event.args ?? '').length;
    return Math.max(1, Math.ceil(chars / 3)) + 4;
}

function compactionRuntimeFor(session: Session): CompactionRuntime | null {
    const service = session.contextV2;
    if (!service) return null;
    let runtime = compactions.get(session);
    if (runtime) return runtime;
    runtime = new CompactionRuntime(
        {
            watermarkTokens: Config.context.SUMMARY_WATERMARK,
            batchTokens: 6000,
            summaryMaxChars: 2000,
            hourlyCap: Config.context.HOURLY_COMPACT_CAP,
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
    compactions.set(session, runtime);
    return runtime;
}

/** 后台滚动摘要：run 结束后调用；水位/节流/小时上限/退避由 runtime 控制 */
export async function compactContextV2(session: Session): Promise<{ advanced: boolean; reason?: string } | null> {
    const runtime = compactionRuntimeFor(session);
    if (!runtime) return null;
    return runtime.maybeRun();
}

/** 清空运行时状态（测试用） */
export function resetContextRuntime(session: Session): void {
    compactions.delete(session);
    cursors.delete(session);
}

/** 最近一次消费到的事件 seq（测试/诊断用） */
export function consumedThrough(session: Session): number {
    return cursors.get(session) ?? 0;
}

function toMessages(items: ReturnType<typeof readRaw>['items']): Array<{ role: string; contentItems: Array<Record<string, unknown>> }> {
    const out: Array<{ role: string; contentItems: Array<Record<string, unknown>> }> = [];
    for (const item of items) {
        if (item.type !== 'event') continue;
        const role = item.kind === 'assistant' ? 'assistant' : item.kind === 'tool_result' ? 'tool' : 'user';
        out.push({
            role,
            contentItems: [{ text: item.text, time: 0, userId: '', messageId: '' }],
        });
    }
    return out;
}

function sourceEvent(kind: ConversationEvent['kind']): boolean {
    return kind === 'user' || kind === 'assistant' || kind === 'tool_result';
}

/**
 * 消费 v2 事件到长期记忆：
 * - 水位 0 = 关闭；积压不足 SETTLE_WATERMARK 不调用；
 * - 读取窗口内未消费事件，交给 MemoryManager.summarizeChunkWithRetry；
 * - 成功才推进 cursors；失败保持原水位（幂等重试）。
 */
export async function consumeContextV2(session: Session): Promise<number> {
    const service = session.contextV2;
    if (!service) return 0;
    if (Config.context.SUMMARY_WATERMARK <= 0) return 0;
    const head = service.head();
    const toSeq = head.nextSeq - 1;
    let cursor = cursors.get(session) ?? Math.max(0, head.epochStartSeq - 1);
    if (cursor < head.epochStartSeq - 1) cursor = head.epochStartSeq - 1;
    if (toSeq <= cursor) return 0;

    const result = readRaw(service.getStore(), service.snapshot(), `e:${cursor + 1}-${toSeq}`, { maxItems: 200, maxChars: 12000 });
    const items = result.items.filter(item => item.type === 'event' && sourceEvent(item.kind));
    if (items.length === 0) {
        if (result.exhausted) cursors.set(session, toSeq);
        return 0;
    }
    const chars = items.reduce((n, item) => n + (item.type === 'event' ? item.text.length : 0), 0);
    if (Math.ceil(chars / 3) < Config.context.SUMMARY_WATERMARK) return 0;
    const state = session.stateOf(Date.now(), { touch: false });
    if (state !== 'COLD' && Config.context.SETTLE_IDLE_SEC > 0
        && Date.now() - session.lastRelevantAt < Config.context.SETTLE_IDLE_SEC * 1000) return 0;

    const messages = toMessages(items);
    let ok = false;
    try {
        ok = await MemoryManager.summarizeChunkWithRetry(session, messages as any);
    } catch {
        ok = false;
    }
    if (!ok) return 0;
    const last = items[items.length - 1];
    const through = last && last.type === 'event' ? last.seq : toSeq;
    cursors.set(session, through);
    return items.length;
}

/** 测试/重置用：清空消费水位 */
export function resetContextBridgeCursor(session: Session): void {
    cursors.delete(session);
}
