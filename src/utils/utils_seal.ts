export function createMsg(messageType: "group" | "private", senderId: string, groupId: string = ''): seal.Message {
    let msg = seal.newMessage();

    if (messageType === 'group') {
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
            const ctx = seal.createTempCtx(eps[i], msg);

            ctx.isPrivate = msg.messageType === 'private';

            if (ctx.player.userId === epId) {
                ctx.player.name = seal.formatTmpl(ctx, "核心:骰子名字");
            }

            return ctx;
        }
    }

    return undefined;
}