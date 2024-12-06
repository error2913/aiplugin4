import { Message } from "../AI/AI";
import { Config } from "./configUtils";

export function repeatDetection(s: string, messages: Message[]): boolean {
    const { stopRepeat } = Config.getRepeatConfig();
    if (!stopRepeat) {
        return false;
    }

    const assContents = messages
        .map((item, index) => {
            return item.role === 'assistant' ? { index, content: item.content } : null;
        })
        .filter(item => item !== null);

    if (assContents.length > 0) {
        const { index, content } = assContents[assContents.length - 1];
        const clearText = content.replace(/<[\|｜\$].*[\|｜\$]>/g, '');
        if (clearText.trim() === s.trim()) {
            messages.splice(index, 1);
            return true;
        }
    }

    return false;
}

export function handleReply(ctx: seal.MsgContext, msg: seal.Message, s: string): { s: string, reply: string, commands: string[] } {
    const { maxChar, cut, replymsg } = Config.getHandleReplyConfig();

    let commands: string[] | null = s.match(/<\$(.+?)\$>/g);

    if (commands !== null) {
        commands = commands.map(item => {
            return item.replace(/<\$|\$>/g, '');
        });
    } else {
        commands = [];
    }

    if (cut) {
        s = s.split('\n')[0];
    }

    const segments = s.split(/<[\|｜]from.*?[\|｜]>/);
    s = segments[0] ? segments[0] : (segments[1] ? segments[1] : s);

    s = s
        .replace(/<[\|｜].*?[\|｜]>/g, '')
        .slice(0, maxChar)

    const prefix = replymsg ? `[CQ:reply,id=${msg.rawId}][CQ:at,qq=${ctx.player.userId.replace(/\D+/g, "")}]` : ``;
    const reply = prefix + s.replace(/<\$(.+?)\$>/g, '');

    return { s, reply, commands };
}