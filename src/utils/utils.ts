import { ToolInfo } from "../tools/tool";

export function getCQTypes(s: string): string[] {
    const match = s.match(/\[CQ:([^,]*?),.*?\]/g);
    if (match) {
        return match.map(item => item.match(/\[CQ:([^,]*?),/)[1]);
    } else {
        return [];
    }
}

export function getMsg(messageType: "group" | "private", senderId: string, groupId: string = ''): seal.Message {
    let msg = seal.newMessage();

    if (messageType == 'group') {
        msg.groupId = groupId;
        msg.guildId = '';
    }

    msg.messageType = messageType;
    msg.sender.userId = senderId;
    return msg;
}

export function getCtx(epId: string, msg: seal.Message): seal.MsgContext | undefined {
    const eps = seal.getEndPoints();

    for (let i = 0; i < eps.length; i++) {
        if (eps[i].userId === epId) {
            return seal.createTempCtx(eps[i], msg);
        }
    }

    return undefined;
}

export function getNameById(epId: string, gid: string, uid: string, diceName: string) {
    if (epId === uid) {
        return diceName;
    }

    const msg = getMsg(gid === '' ? 'private': 'group', uid, gid);
    const ctx = getCtx(epId, msg);

    return ctx.player.name || '未知用户';
}

export function parseBody(template: string[], messages: any[], tools: ToolInfo[], tool_choice: "none" | "auto" | "required") {
    try {
        const bodyObject = JSON.parse(`{${template.join(',')}}`);

        if (bodyObject.messages === null) {
            bodyObject.messages = messages;
        }

        if (bodyObject.stream !== false) {
            console.error(`不支持流式传输，请将stream设置为false`);
            bodyObject.stream = false;
        }

        if (bodyObject.tools === null) {
            bodyObject.tools = tools;
        }

        if (bodyObject.tool_choice === null) {
            bodyObject.tool_choice = tool_choice;
        }

        return bodyObject;
    } catch (err) {
        throw new Error(`解析body时出现错误:${err}`);
    }
}

export function getUrlsInCQCode(s: string): string[] {
    const match = s.match(/\[CQ:image,file=(http.*?)\]/g);
    if (match !== null) {
        const urls = match.map(item => item.match(/\[CQ:image,file=(http.*?)\]/)[1]);
        return urls;
    } else {
        return [];
    }
}

export function levenshteinDistance(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const dp = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) {
        dp[i][0] = i;
    }
    for (let j = 0; j <= len2; j++) {
        dp[0][j] = j;
    }
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1, // 删除
                    dp[i][j - 1] + 1, // 插入
                    dp[i - 1][j - 1] + 1 // 替换
                );
            }
        }
    }
    return dp[len1][len2];
}

export function calculateSimilarity(s1: string, s2: string): number {
    if (s1.length === 0 || s2.length === 0) {
        return 0;
    }
    
    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - distance / maxLength;
}