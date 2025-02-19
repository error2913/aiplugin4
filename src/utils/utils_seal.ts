export function createMsg(messageType: "group" | "private", senderId: string, groupId: string = ''): seal.Message {
    let msg = seal.newMessage();

    if (messageType == 'group') {
        msg.groupId = groupId;
        msg.guildId = '';
    }

    msg.messageType = messageType;
    msg.sender.userId = senderId;
    return msg;
}

export function createCtx(epId: string, msg: seal.Message): seal.MsgContext | undefined {
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

    const msg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
    const ctx = createCtx(epId, msg);

    return ctx.player.name || '未知用户';
}