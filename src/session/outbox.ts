// 会话发件箱：回复投递（分段延时 → replyToSender → 上下文回填 → 落盘）与 headless 收集。
// 从 session.ts 拆出：发送策略只依赖 Config.reply / replyToSender / session.context，
// 与「何时该回复」的触发编排解耦；session.ts 保留 reply() 委派，外部调用点零改动。
import Config from "../config/config";
import type Image from "../resource/image";
import { replyToSender } from "../utils/utils";

import type { Session } from "./session";

export interface ReplyOptions {
    withSegmentDelay?: boolean;
}

export async function deliverReply(
    session: Session,
    ctx: seal.MsgContext,
    msg: seal.Message,
    contextArray: string[],
    replyArray: string[],
    _images: Image[],
    options: ReplyOptions = {},
    reasoningContent?: string
): Promise<void> {
    // headless（子代理）：不向聊天发送，仅把回复写入上下文与 transcript
    if (session.headless) {
        for (let i = 0; i < contextArray.length; i++) {
            const content = contextArray[i];
            const reply = replyArray[i];
            await session.context.addAssistantMessage(content, `sub:${session.headlessTranscript.length}`, reasoningContent);
            if (reply !== undefined && reply.trim() !== '') session.headlessTranscript.push(reply);
        }
        return;
    }
    const { withSegmentDelay = false } = options;
    const { SEGMENT_DELAY_ENABLED, SEGMENT_DELAY_MS, SEGMENT_IMAGE_EXTRA_DELAY_MS } = Config.reply;

    for (let i = 0; i < contextArray.length; i++) {
        const content = contextArray[i];
        const reply = replyArray[i];

        // 分段发送延时（流式/非流式共用）：从第二条起，发送前等待配置的毫秒数，防止乱序
        if (withSegmentDelay && SEGMENT_DELAY_ENABLED && i > 0) {
            let delayMs = Math.max(0, SEGMENT_DELAY_MS);
            if (/\[CQ:image(?:,[^\]]*)?\]/.test(reply)) {
                delayMs += Math.max(0, SEGMENT_IMAGE_EXTRA_DELAY_MS);
            }
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        const msgId = await replyToSender(ctx, msg, session, reply);
        await session.context.addAssistantMessage(content, msgId, reasoningContent);
    }
    // 回复与助手消息属于"必须落盘"的关键变更（保存节流只作用于高频入库路径）
    session.save();
}
