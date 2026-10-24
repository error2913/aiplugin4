// 会话收件箱：消息入库（直接/挂起）、挂起队列 drain/flush、后台完成通知 flush。
// 从 session.ts 拆出：这些是「收信与排空」策略，只操作 session.context / pendingQueue / noticeQueue，
// 与聊天编排（chat/stream）解耦；session.ts 保留同名方法委派，外部调用点零改动。
// 注意：媒体任务的「已送达」回置通过参数注入（不 import media 实现），避免把媒体模块拉进会话环。
import { markMediaNotified } from "../core/ports/media_notice";
import { logger } from "../logger";
import { getRecordMessageId } from "../utils/message_id";
import { transformArrayToContent } from "../utils/string";
import type { MessageSegment } from "../utils/string";

import { PendingMessage, writePendingRecord } from "./persistence";
import type { Session } from "./session";

const log = logger.withTag('session');

/** 普通收信：转内容并直接入上下文（非忙态） */
export async function handleReceipt(session: Session, ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[]): Promise<void> {
    session.lastCtx = ctx;
    const { content } = await transformArrayToContent(ctx, messageArray, getRecordMessageId(ctx, msg));
    await session.context.addUserMessage(ctx, content, ctx.player!.userId, getRecordMessageId(ctx, msg));
}

/** 会话忙时挂起消息：与 handleReceipt 等价但不入库，进入 pendingQueue 由 flushPending 统一处理（不触发并发） */
export async function deferReceipt(session: Session, ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[], kind: 'trigger' | 'record', systemReason?: string): Promise<void> {
    session.lastCtx = ctx;
    const { content } = await transformArrayToContent(ctx, messageArray, getRecordMessageId(ctx, msg));
    session.pendingQueue.push({
        ctx,
        msg,
        content,
        userId: ctx.player!.userId,
        messageId: getRecordMessageId(ctx, msg),
        kind,
        systemReason,
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
export async function flushPending(session: Session): Promise<boolean> {
    const pending = drainPending(session);
    if (pending.length === 0) return false;
    let hasTrigger = false;
    for (const p of pending) {
        if (p.kind === 'trigger') hasTrigger = true;
        await session.context.addUserMessage(p.ctx, p.content, p.userId, p.messageId);
        if (p.systemReason) await session.context.addSystemUserMessage(p.systemReason, '触发原因提示');
    }
    session.save();
    session.clearPending();
    return hasTrigger;
}

/**
 * 把后台完成通知队列写入上下文（每轮模型请求前调用，与 flushPending 同点）；返回条数。
 * 两类来源分开口径：媒体生成任务用 `[system:生成任务]`，子代理结算用 `[system:子代理]`
 * 并附 `raw: subagent-notice`（供生命周期清扫识别）。
 */
export async function flushNotices(session: Session): Promise<number> {
    const queue = session.noticeQueue;
    if (queue.length === 0) return 0;
    session.noticeQueue = [];
    for (const n of queue) {
        if (n.kind === 'media') {
            await session.context.addSystemUserMessage(n.text, '生成任务');
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
        const tag = n.from && n.from !== '' ? `子代理 ${n.from} ` : '子代理 ';
        // raw 标记：子代理生命周期绑定（父上下文淘汰该 notice 时清扫对应记录）
        await session.context.addSystemUserMessage(tag + n.text, '子代理', {
            raw: { kind: 'subagent-notice', childId: n.from || '' },
        });
    }
    return queue.length;
}

/** 清空挂起队列分片：空队列即清空存档，避免重载后残留脏数据复活 */
export function clearPendingRecord(session: Session): void {
    writePendingRecord(session.sessionId, null);
}
