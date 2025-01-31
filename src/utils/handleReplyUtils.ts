import { Context } from "../AI/context";
import { ConfigManager } from "./configUtils";
import { calculateSimilarity } from "./utils";

export function handleReply(ctx: seal.MsgContext, msg: seal.Message, s: string, context: Context): { s: string, reply: string, isRepeat: boolean } {
    const { maxChar, cut, replymsg, stopRepeat, similarityLimit } = ConfigManager.getHandleReplyConfig();

    // 处理分割
    if (cut) {
        s = s.split('\n')[0];
    }

    const segments = s
        .split(/<[\|｜].*?[\|｜]?>/)
        .filter(item => item.trim() !== '');
    if (segments.length === 0) {
        return { s: '', reply: '', isRepeat: false };
    }

    s = segments[0]
        .replace(/<br>/g, '\n')
        .slice(0, maxChar)
    const prefix = replymsg ? `[CQ:reply,id=${msg.rawId}][CQ:at,qq=${ctx.player.userId.replace(/\D+/g, "")}] ` : ``;
    const reply = prefix + s
        .replace(/<@(.+?)>/g, (_, p1) => {
            const uid = context.findUid(p1);
            if (uid !== null) {
                return `[CQ:at,qq=${uid.replace(/\D+/g, "")}] `;
            } else {
                return ` @${p1} `;
            }
        })
        .replace(/<\$(.+?)\$?>/g, '');

    // 检查复读
    let isRepeat = false;
    if (stopRepeat) {
        const messages = context.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            // 寻找最后一条文本消息
            if (message.role === 'assistant' && !message?.tool_calls) {
                const content = message.content;
                const clearText = content.replace(/<[\|｜].*?[\|｜]>/g, '');
                const similarity = calculateSimilarity(clearText.trim(), s.trim());
                ConfigManager.printLog(`复读相似度：${similarity}`);
                if (similarity > similarityLimit) {
                    isRepeat = true;

                    let start = i;
                    let count = 1;
                    for (let j = i -1; j >= 0; j--) {
                        const message = messages[j];
                        if (message.role === 'tool'|| (message.role === 'assistant' && message?.tool_calls)) {
                            start = j;
                            count++;
                        } else {
                            break;
                        }
                    }

                    messages.splice(start, count);
                }

                break;
            }
        }
    }

    return { s, reply, isRepeat };
}