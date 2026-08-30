import { createCtx, createMsg } from "../utils/seal";
import { getPlatform, getRawId, normalizeGroupId, normalizeUserId, platformOf } from "../utils/target_id";

export interface CommandTargetOptions {
    /** 显式指定指令消息的触发用户；未填写时由调用方使用当前会话用户。 */
    trigger?: string;
    /** 指令消息中的 @ 用户列表。 */
    at: string[];
}

/** 将用户标识严格规范化为可注入 OB11/海豹消息的原始用户 ID。 */
export function normalizeCommandUserId(value: any, platformHint?: string): string | undefined {
    const normalized = normalizeUserId(String(value == null ? '' : value), platformHint);
    return normalized ? getRawId(normalized) : undefined;
}

export function currentCommandUserId(ctx: seal.MsgContext): string {
    const hint = platformOf(ctx);
    return normalizeCommandUserId(ctx.player && ctx.player.userId, hint)
        || normalizeCommandUserId(ctx.endPoint.userId, hint)
        || '';
}

export function qualifyCommandUserId(ctx: seal.MsgContext, userId: string): string {
    const platform = getPlatform(ctx.endPoint.userId || '');
    return platform ? `${platform}:${userId}` : userId;
}

/** 解析工具参数；不对旧字段做兼容，at 必须是数组。 */
export function resolveCommandTarget(ctx: seal.MsgContext, args: { [key: string]: any } | undefined): CommandTargetOptions & { effectiveTrigger: string } {
    const trigger = normalizeCommandUserId(args && args.trigger, platformOf(ctx));
    const atValue = args && args.at;
    const at = Array.isArray(atValue)
        ? atValue.map((value: any) => normalizeCommandUserId(value, platformOf(ctx))).filter((item: string | undefined): item is string => !!item)
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
    // Message.groupId 必须保留 SealDice 的平台前缀（如 QQ-Group:123），
    // 否则 OB11 核心在 SendToGroup 时无法命中群会话，也不会触发 onMessageSend。
    const normalizedGroupId = ctx.group && normalizeGroupId(ctx.group.groupId, platformOf(ctx));
    const groupId = normalizedGroupId || '';
    const triggerUserId = qualifyCommandUserId(ctx, target.trigger);
    const msg = createMsg(ctx.isPrivate ? 'private' : 'group', triggerUserId, groupId);
    if (target.at.length) {
        const atText = target.at.map(userId => `[CQ:at,qq=${userId}]`).join(' ');
        msg.message = `${atText} `;
        (msg as any).segment = target.at.map(userId => ({
            target: userId,
            isRobot: userId === normalizeCommandUserId(ctx.endPoint.userId, platformOf(ctx)),
            type: () => 1
        }));
    }
    // 显式切换触发用户时不能沿用当前会话发送者的昵称；否则本地扩展指令（如 rav）
    // 会以当前 AI 对话用户的名字执行，而不是以 target.trigger 对应的玩家执行。
    // 未切换触发者时仍保留原消息昵称，避免普通 @ 模拟丢失当前玩家显示名。
    const currentUserId = currentCommandUserId(ctx);
    if (msg.sender && target.trigger === currentUserId) msg.sender.nickname = ctx.player && ctx.player.name || '';
    const targetCtx = createCtx(ctx.endPoint.userId, msg);
    if (!targetCtx) throw new Error(`未找到通信端点: ${ctx.endPoint.userId}`);
    return { ctx: targetCtx, msg };
}
