// seal 上下文工具：构造 ctx/msg/会话ID
export function createMsg(messageType: "group" | "private", uid: string, gid: string = ''): seal.Message {
    const msg = seal.newMessage();
    // goja 运行时下新建 Message 可能缺 segment 字段（jsbind 数组默认不初始化），
    // 显式置空数组，供 milky 回调按 msg.segment 是否非空判断消息来源
    (msg as any).segment = [];
    if (messageType === 'group') {
        msg.groupId = gid;
        msg.guildId = '';
    }
    msg.messageType = messageType;
    msg.sender.userId = uid;
    return msg;
}

function buildCtx(ep: seal.EndPointInfo, msg: seal.Message): seal.MsgContext {
    const ctx = seal.createTempCtx(ep, msg);
    ctx.isPrivate = msg.messageType === 'private';
    if (ctx.player!.userId === ep.userId) ctx.player!.name = seal.formatTmpl(ctx, "核心:骰子名字");
    return ctx;
}

/** 按 epId 反查端点构造临时 ctx。
 *  双连接冗余下同一 QQ 可能同时存在直连与桥两个端点：优先选 state=1（已连接）的端点，
 *  避免桥账号排在列表前面且已断线时，挂起/定时/重载后重建的 ctx 选中断线端点导致回复丢失；
 *  全部不在线时回退到第一个匹配端点（与旧行为一致）。 */
export function createCtx(epId: string, msg: seal.Message): seal.MsgContext | undefined {
    const eps = seal.getEndPoints();
    let fallback: seal.EndPointInfo | undefined;
    for (const ep of eps) {
        if (ep.userId !== epId) continue;
        if (Number(ep.state) === 1) return buildCtx(ep, msg);
        if (!fallback) fallback = ep;
    }
    return fallback ? buildCtx(fallback, msg) : undefined;
}

export function getCtxAndMsg(epId: string, uid: string, gid: string): { ctx: seal.MsgContext, msg: seal.Message } {
    const msg = createMsg(gid ? 'group' : 'private', uid, gid);
    const ctx = createCtx(epId, msg);
    if (!ctx) throw new Error(`未找到通信端点: ${epId}`);
    return { ctx, msg };
}

export function getSessionCtxAndMsg(epId: string, sid: string, isPrivate: boolean): { ctx: seal.MsgContext, msg: seal.Message } {
    const args: ["group" | "private", string, string] = isPrivate ? ['private', sid, ''] : ['group', '', sid];
    const msg = createMsg(...args);
    const ctx = createCtx(epId, msg);
    if (!ctx) throw new Error(`未找到通信端点: ${epId}`);
    return { ctx, msg };
}

/**
 * 为公开会话目录（pub_send）构建目标上下文：按 botId 找到【在线】端点后建临时 ctx。
 * 与 createCtx 不同：createCtx 在端点断线时允许回退到第一个匹配端点（定时器等场景可容忍），
 * 而跨端点外发必须落到明确在线账号，避免把消息发到断线端点导致丢失/无回执。
 * @param botId 目标端点 userId（如 QQ:123456，含平台前缀）
 * @param sid   目标会话 ID（群聊通常含 -Group:；按原样使用，不做格式假设）
 * @param isPrivate 私聊还是群聊
 * @returns {ctx,msg}；端点不存在或不在线时抛错（message 含原因），由调用方转成工具可读错误
 */
export function createOnlinePubCtx(botId: string, sid: string, isPrivate: boolean): { ctx: seal.MsgContext, msg: seal.Message } {
    const eps = seal.getEndPoints();
    const all = (eps || []) as seal.EndPointInfo[];
    // goja 下 state 可能为 Number 对象/字符串，统一数值归一后判断（1=已连接）
    const online = all.find((item: seal.EndPointInfo) => item.userId === botId && Number(item.state) === 1);
    if (online) {
        const msg = createMsg(isPrivate ? 'private' : 'group', isPrivate ? sid : '', isPrivate ? '' : sid);
        const ctx = seal.createTempCtx(online, msg);
        ctx.isPrivate = isPrivate;
        if (isPrivate) {
            if (ctx.player!.userId === online.userId) ctx.player!.name = seal.formatTmpl(ctx, "核心:骰子名字");
        }
        return { ctx, msg };
    }
    const offline = all.find((item: seal.EndPointInfo) => item.userId === botId);
    if (offline) {
        throw new Error(`目标 Bot 未连接（state=${Number(offline.state)}），无法发送: ${botId}`);
    }
    throw new Error(`未找到目标 Bot 端点: ${botId}`);
}

export function getSessionId(ctx: seal.MsgContext): string {
    return ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId;
}
