export function createMsg(messageType: "group" | "private", uid: string, gid: string = ''): seal.Message {
    let msg = seal.newMessage();
    if (messageType === 'group') {
        msg.groupId = gid;
        msg.guildId = '';
    }
    msg.messageType = messageType;
    msg.sender.userId = uid;
    return msg;
}

export function createCtx(epId: string, msg: seal.Message): seal.MsgContext | undefined {
    const eps = seal.getEndPoints();
    for (let i = 0; i < eps.length; i++) {
        if (eps[i].userId === epId) {
            const ctx = seal.createTempCtx(eps[i], msg);
            ctx.isPrivate = msg.messageType === 'private';
            if (ctx.player.userId === epId) ctx.player.name = seal.formatTmpl(ctx, "核心:骰子名字");
            return ctx;
        }
    }
    return undefined;
}

export function getCtxAndMsg(epId: string, uid: string, gid: string): { ctx: seal.MsgContext, msg: seal.Message } {
    const msg = createMsg(gid ? 'group' : 'private', uid, gid);
    const ctx = createCtx(epId, msg);
    return { ctx, msg };
}

export function getSessionCtxAndMsg(epId: string, sid: string, isPrivate: boolean): { ctx: seal.MsgContext, msg: seal.Message } {
    const args: ["group" | "private", string, string] = isPrivate ? ['private', sid, ''] : ['group', '', sid];
    const msg = createMsg(...args);
    const ctx = createCtx(epId, msg);
    return { ctx, msg };
}