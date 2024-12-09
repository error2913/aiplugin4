import { Context } from "../AI/context";
import { ConfigManager } from "./configUtils";
import { calculateSimilarity } from "./utils";

export function handleReply(ctx: seal.MsgContext, msg: seal.Message, s: string, context: Context): { s: string, reply: string, commands: string[], isRepeat: boolean } {
    const { maxChar, cut, replymsg, stopRepeat, similarityLimit } = ConfigManager.getHandleReplyConfig();

    // 处理命令
    let commands: string[] | null = s.match(/<\$(.+?)\$?>/g);
    if (commands !== null) {
        commands = commands.map(item => {
            return item.replace(/<\$|\$?>/g, '');
        });
    } else {
        commands = [];
    }

    // 处理分割
    if (cut) {
        s = s.split('\n')[0];
    }

    const segments = s
        .split(/<[\|｜].*?[\|｜]?>/)
        .filter(item => item !== '');
    if (segments.length === 0) {
        return { s: '', reply: '', commands: [], isRepeat: false };
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
        const assContents = context.messages
            .map((item, index) => {
                return item.role === 'assistant' ? { index, content: item.content } : null;
            })
            .filter(item => item !== null);

        if (assContents.length > 0) {
            const { index, content } = assContents[assContents.length - 1];
            const clearText = content.replace(/<[\|｜].*?[\|｜]>/g, '');
            const similarity = calculateSimilarity(clearText.trim(), s.trim());
            ConfigManager.printLog(`复读相似度：${similarity}`);
            if (similarity > similarityLimit) {
                context.messages.splice(index, 1);
                isRepeat = true;
            }
        }
    }

    return { s, reply, commands, isRepeat };
}