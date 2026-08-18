import { createCtx, createMsg } from "../utils/seal";

export interface CommandTargetOptions {
    triggerUserId?: string;
    atUserId?: string;
}

/** 将 QQ:123 / 123 等用户标识统一为可注入 OB11/海豹消息的纯用户 ID。 */
export function normalizeCommandUserId(value: any): string | undefined {
    const text = String(value == null ? '' : value).trim().replace(/^.+:/, '');
    return text || undefined;
}

export function qualifyCommandUserId(ctx: seal.MsgContext, userId: string): string {
    const platform = String(ctx.endPoint.userId || '').split(':', 1)[0];
    return platform ? `${platform}:${userId}` : userId;
}

export function resolveCommandTarget(ctx: seal.MsgContext, args: { [key: string]: any } | undefined): CommandTargetOptions & { triggerUserId: string } {
    const currentUserId = normalizeCommandUserId(ctx.player && ctx.player.userId) || normalizeCommandUserId(ctx.endPoint.userId) || '';
    const triggerUserId = normalizeCommandUserId(args && args.triggerUserId) || currentUserId;
    const atUserId = normalizeCommandUserId(args && args.atUserId);
    return { triggerUserId, ...(atUserId ? { atUserId } : {}) };
}

export function buildCommandContext(
    ctx: seal.MsgContext,
    target: CommandTargetOptions & { triggerUserId: string }
): { ctx: seal.MsgContext; msg: seal.Message } {
    const groupId = ctx.group && normalizeCommandUserId(ctx.group.groupId) || '';
    const msg = createMsg(ctx.isPrivate ? 'private' : 'group', target.triggerUserId, groupId);
    if (target.atUserId) {
        const atText = `[CQ:at,qq=${target.atUserId}]`;
        msg.message = `${atText} `;
        (msg as any).segment = [{
            target: target.atUserId,
            isRobot: target.atUserId === normalizeCommandUserId(ctx.endPoint.userId),
            type: () => 1
        }];
    }
    if (msg.sender) msg.sender.nickname = ctx.player && ctx.player.name || '';
    const targetCtx = createCtx(ctx.endPoint.userId, msg);
    if (!targetCtx) throw new Error(`未找到通信端点: ${ctx.endPoint.userId}`);
    return { ctx: targetCtx, msg };
}
