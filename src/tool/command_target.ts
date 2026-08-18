import { createCtx, createMsg } from "../utils/seal";
import { getRawId, normalizeGroupId, normalizeUserId } from "../utils/target_id";

export interface CommandTargetOptions {
    /** 显式指定指令消息的触发用户；未填写时由调用方使用当前会话用户。 */
    trigger?: string;
    /** 指令消息中的 @ 用户列表。 */
    at: string[];
}

/** 将用户标识严格规范化为可注入 OB11/海豹消息的原始用户 ID。 */
export function normalizeCommandUserId(value: any): string | undefined {
    const normalized = normalizeUserId(String(value == null ? '' : value));
    return normalized ? getRawId(normalized) : undefined;
}

export function currentCommandUserId(ctx: seal.MsgContext): string {
    return normalizeCommandUserId(ctx.player && ctx.player.userId)
        || normalizeCommandUserId(ctx.endPoint.userId)
        || '';
}

export function qualifyCommandUserId(ctx: seal.MsgContext, userId: string): string {
    const platform = String(ctx.endPoint.userId || '').split(':', 1)[0];
    return platform ? `${platform}:${userId}` : userId;
}

/** 解析工具参数；不对旧字段做兼容，at 必须是数组。 */
export function resolveCommandTarget(ctx: seal.MsgContext, args: { [key: string]: any } | undefined): CommandTargetOptions & { effectiveTrigger: string } {
    const trigger = normalizeCommandUserId(args && args.trigger);
    const at = Array.isArray(args && args.at)
        ? args.at.map(normalizeCommandUserId).filter((item): item is string => !!item)
        : [];
    return {
        ...(trigger ? { trigger } : {}),
        at,
        effectiveTrigger: trigger || currentCommandUserId(ctx)
    };
}

export function buildCommandContext(
    ctx: seal.MsgContext,
    target: { trigger: string; at: string[] }
): { ctx: seal.MsgContext; msg: seal.Message } {
    const normalizedGroupId = ctx.group && normalizeGroupId(ctx.group.groupId);
    const groupId = normalizedGroupId ? getRawId(normalizedGroupId) : '';
    const msg = createMsg(ctx.isPrivate ? 'private' : 'group', target.trigger, groupId);
    if (target.at.length) {
        const atText = target.at.map(userId => `[CQ:at,qq=${userId}]`).join(' ');
        msg.message = `${atText} `;
        (msg as any).segment = target.at.map(userId => ({
            target: userId,
            isRobot: userId === normalizeCommandUserId(ctx.endPoint.userId),
            type: () => 1
        }));
    }
    if (msg.sender) msg.sender.nickname = ctx.player && ctx.player.name || '';
    const targetCtx = createCtx(ctx.endPoint.userId, msg);
    if (!targetCtx) throw new Error(`未找到通信端点: ${ctx.endPoint.userId}`);
    return { ctx: targetCtx, msg };
}
