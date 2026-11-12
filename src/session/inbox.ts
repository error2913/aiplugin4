// 会话收件箱：消息入库（直接/挂起）、挂起队列 drain/flush、后台完成通知 flush。
// 从 session.ts 拆出：这些是「收信与排空」策略，只操作 session.context / pendingQueue / noticeQueue，
// 与聊天编排（chat/stream）解耦；session.ts 保留同名方法委派，外部调用点零改动。
// 注意：媒体任务的「已送达」回置通过参数注入（不 import media 实现），避免把媒体模块拉进会话环。
import { archiveControllerFor } from "../context/compact/session_runtime";
import { markMediaNotified } from "../core/ports/media_notice";
import { logger } from "../logger";
import { getRecordMessageId } from "../utils/message_id";
import { SYSTEM_NAME } from "../utils/protocol";
import { transformArrayToContent } from "../utils/string";
import type { MessageSegment } from "../utils/string";

import { PendingMessage, writePendingRecord } from "./persistence";
import { extractQuoteId, resolveQuote } from "./quote";
import type { QuoteDraft } from "./quote";
import type { Session } from "./session";

const log = logger.withTag('session');

/** 引用展开失败时的占位前缀（REQ-D6-03；拼进正文而非单独事件：失败时没有可信发言人，避免伪造 [from:unknown]） */
function quotePlaceholder(quoteId: string): string {
    return `[quote_unavailable:${quoteId}] `;
}

/** 普通收信：转内容并直接入上下文（非忙态） */
export async function handleReceipt(session: Session, ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[], opts?: { updateRef?: boolean }): Promise<void> {
    session.lastCtx = ctx;
    // A12：记录最近一条真实用户消息的原始 rawId（按端点），供定时/自主/事件触发回填引用。
    // bot 自身消息、命令、ob11 补收由调用方传 updateRef:false。
    session.noteInboundRef(ctx, msg, opts?.updateRef !== false);
    const { content: rawContent } = await transformArrayToContent(ctx, messageArray, getRecordMessageId(ctx, msg));
    let content = rawContent;
    // REQ-D6-10：引用展开挂在收信层，不动 transformArrayToContent 契约（它仍产出 [quote:<id>] 文本）
    const quoteId = extractQuoteId(messageArray);
    let quote: QuoteDraft | null = null;
    if (quoteId) {
        quote = await resolveQuote(session, ctx, msg, quoteId);
        if (!quote) content = quotePlaceholder(quoteId) + content;
    }
    await session.context.addUserMessageWithQuote(ctx, content, ctx.player!.userId, getRecordMessageId(ctx, msg), quote);
    // v7 待机路径：非忙态入库后，T ≥ C 时零 LLM 归档（总结在飞时控制器自行跳过）
    if (!session.running && !session.starting) {
        try { archiveControllerFor(session)?.onIdleAppend(); } catch { /* 归档失败不影响入库 */ }
    }
}

/** 会话忙时挂起消息：与 handleReceipt 等价但不入库，进入 pendingQueue 由 flushPending 统一处理（不触发并发） */
export async function deferReceipt(session: Session, ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[], kind: 'trigger' | 'record', systemReason?: string, systemName?: string, opts?: { updateRef?: boolean }): Promise<void> {
    session.lastCtx = ctx;
    session.noteInboundRef(ctx, msg, opts?.updateRef !== false);
    const { content } = await transformArrayToContent(ctx, messageArray, getRecordMessageId(ctx, msg));
    // REQ-D6-11：忙态只记被引 msgId，**不展开**（不在轮子跑的时候做网络/IO），等 flushPending 再展开
    const quoteOf = extractQuoteId(messageArray) || undefined;
    session.pendingQueue.push({
        ctx,
        msg,
        content,
        ...(quoteOf ? { quoteOf } : {}),
        userId: ctx.player!.userId,
        messageId: getRecordMessageId(ctx, msg),
        kind,
        systemReason,
        systemName,
        epId: ctx.endPoint.userId,
        isPrivate: ctx.isPrivate,
    });
}

/** 取出并清空挂起队列 */
export function drainPending(session: Session): PendingMessage[] {
    const pending = session.pendingQueue;
    session.pendingQueue = [];
    return pending;
}

/** 把挂起队列全部写入上下文（此时上一轮工具回调已入库，位置合法）并保存；返回是否存在触发类消息 */
export async function flushPending(session: Session, opts?: { writeTriggerPrompts?: boolean }): Promise<boolean> {
    const pending = drainPending(session);
    if (pending.length === 0) return false;
    let hasTrigger = false;
    // 触发闸关闭（.ai off）时不再写 trigger 提示：消息内容照常入库，但不留无法兑现的"请说话"
    const writeTriggerPrompts = opts?.writeTriggerPrompts !== false;
    for (const p of pending) {
        if (p.kind === 'trigger') hasTrigger = true;
        // 事件触发挂起没有用户消息内容，只写触发系统提示（避免产生空 user 事件）
        if (p.content) {
            let content = p.content;
            let quote: QuoteDraft | null = null;
            // REQ-D6-11：忙态没展开的引用在这里补展开，写库时引用事件紧邻回复事件之前
            if (p.quoteOf && session.contextV2) {
                quote = await resolveQuote(session, p.ctx, p.msg, p.quoteOf);
                if (!quote) content = quotePlaceholder(p.quoteOf) + content;
            }
            await session.context.addUserMessageWithQuote(p.ctx, content, p.userId, p.messageId, quote);
        }
        if (p.systemReason && (p.kind !== 'trigger' || writeTriggerPrompts)) {
            await session.context.addSystemUserMessage(p.systemReason, p.systemName || SYSTEM_NAME.trigger);
        }
    }
    session.save();
    session.clearPending();
    return hasTrigger;
}

/**
 * 把后台完成通知队列写入上下文（每轮模型请求前调用，与 flushPending 同点）；返回条数。
 * 两类来源分开口径：媒体生成任务用 `[system:media-task]`，子代理结算用 `[system:subagent]`
 * 并附 `raw: subagent-notice`（供生命周期清扫识别）。
 */
export async function flushNotices(session: Session): Promise<number> {
    const queue = session.noticeQueue;
    if (queue.length === 0) return 0;
    session.noticeQueue = [];
    for (const n of queue) {
        if (n.kind === 'media') {
            await session.context.addSystemUserMessage(n.text, SYSTEM_NAME.mediaTask);
            // 真正呈现给 AI 后才回置 notified：这是"结果已送达、不再需要任何补发"的唯一时机。
            // 放在入队时置位会谎报成功，让重载补发与轮末补触发两条兜底同时失效（原实现的永久等待）。
            if (n.taskId) {
                try {
                    markMediaNotified(session.sessionId, n.taskId);
                } catch (e) {
                    log.warning(`媒体任务 #${n.taskId} 回置 notified 失败：${e instanceof Error ? e.message : String(e)}`);
                }
            }
            continue;
        }
        const tag = n.from && n.from !== '' ? `Sub-agent ${n.from} ` : 'Sub-agent ';
        // raw 标记：子代理生命周期绑定（父上下文淘汰该 notice 时清扫对应记录）
        await session.context.addSystemUserMessage(tag + n.text, SYSTEM_NAME.subagent, {
            raw: { kind: 'subagent-notice', childId: n.from || '' },
        });
    }
    return queue.length;
}

/** 清空挂起队列分片：空队列即清空存档，避免重载后残留脏数据复活 */
export function clearPendingRecord(session: Session): void {
    writePendingRecord(session.sessionId, null);
}
