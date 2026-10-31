// @ 检测（L2 纯函数）：判断消息段里是否 @ 了机器人自己（R17，第 9 个单触发模式 `at` 的叶子）。
//
// 为什么不用正则：milky 下 at 在消息段里（ElementType 1 → {type:'at',data:{qq}}），
// ob11 同样是 {type:'at'}；而 `[CQ:at,qq=…]` 只是 formatMessageSegmentsForMatching 给
// 正则用的文本投影。默认正则里的 at CQ 已删除，统一由本函数判定，两条路径行为一致。
import type { MessageSegment } from "./string";
import { getPlatform, normalizeUserId } from "./target_id";

/**
 * 是否 @ 了机器人（仅群聊）。
 * - `@全体`（qq=all）不算；
 * - `data.qq` 或 `data.user_id` 均接受（不同来源字段名不同）；
 * - 用 normalizeUserId 归一后与 `ctx.endPoint.userId` 比较，兼容带平台前缀/裸号两种形态。
 */
export function detectBotMention(messageArray: readonly MessageSegment[] | undefined, ctx: seal.MsgContext): boolean {
    if (!messageArray || messageArray.length === 0) return false;
    if (ctx.isPrivate) return false;
    const botRaw = ctx.endPoint && ctx.endPoint.userId;
    if (!botRaw) return false;
    // 平台从 bot 的 UNI-ID 自身推导（`QQ:123` → QQ），避免 ctx.endPoint.platform 大小写/缺省差异
    const platform = getPlatform(botRaw);
    const botId = normalizeUserId(botRaw, platform) || String(botRaw);
    for (const seg of messageArray) {
        if (!seg || seg.type !== 'at') continue;
        const data = (seg as { data?: { qq?: unknown; user_id?: unknown } }).data;
        const raw = data ? (data.qq ?? data.user_id) : undefined;
        if (raw === undefined || raw === null) continue;
        const text = String(raw).trim();
        if (!text || text === 'all') continue;
        const userId = normalizeUserId(text, platform) || text;
        if (userId === botId) return true;
    }
    return false;
}
