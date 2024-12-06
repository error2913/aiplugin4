
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

export function parseBody(template: string[], messages: any[]) {
    try {
        const bodyObject = JSON.parse(`{${template.join(',')}}`);

        if (bodyObject.messages === null) {
            bodyObject.messages = messages;
        }

        if (bodyObject.stream !== false) {
            console.error(`不支持流式传输，请将stream设置为false`);
            bodyObject.stream = false;
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