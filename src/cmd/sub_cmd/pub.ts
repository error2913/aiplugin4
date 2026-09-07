// .ai pub：公开会话目录管理
// - list：平铺展示全部公开会话
// - add：把当前会话公开到目录（幂等；发布即允许 pub_read / pub_send）
// - rm：无参=移出当前会话；或带 --platform/--botid/--session 过滤删除命中条目（按存储的字符串原样匹配）
// 权限默认骰主级，可用 .ai priv 调整；帮助文案不写死权限。
import {
    getEntryBySession, listEntries, publishCurrentSession, removeByFilters,
} from "../../pub/registry";
import { aliasToCmd } from "../../utils/utils";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

function helpText(): string {
    return `帮助: 公开会话目录管理
  【.ai pub list】展示全部公开会话
  【.ai pub add】把当前会话公开到目录（重复执行=更新）
  【.ai pub rm】把当前会话移出目录
  【.ai pub rm --platform=<平台> [--botid=<BotID>] [--session=<会话ID>]】按过滤删除命中条目
  过滤说明：
  - --platform=<QQ> 删除该平台目录下全部条目
  - --botid=<QQ:123> 删除该 Bot 下全部条目（可加 --platform 缩小范围）
  - --session=<QQ-Group:456> 删除所有该会话条目（可加 --platform/--botid 缩小范围）
  - 多个过滤条件为交集；至少提供一个条件
  - 注：botid/会话ID 按目录中记录的原样匹配（不要求一定是 UNI-ID 形态）`;
}

export function registerCmdPub() {
    const cmd = new SubCmd('pub');
    cmd.desc = '公开会话目录管理';
    cmd.help = helpText();
    cmd.priv = { priv: M };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret, sid } = scc;
        const op = aliasToCmd(cmdArgs.getArgN(2));

        switch (op) {
            case '': {
                seal.replyToSender(ctx, msg, helpText());
                return ret;
            }
            case 'list': {
                const entries = listEntries();
                if (entries.length === 0) {
                    seal.replyToSender(ctx, msg, '【公开会话目录】当前没有公开会话。使用 .ai pub add 把当前会话公开到目录。');
                    return ret;
                }
                // 树状分段：平台组头一行 → botid 行（无缩进）→ 会话行（两格缩进）
                const platforms: { [platform: string]: { [botId: string]: string[] } } = {};
                const sorted = [...entries].sort((a, b) => {
                    if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
                    if (a.botId !== b.botId) return a.botId.localeCompare(b.botId);
                    return a.sid.localeCompare(b.sid);
                });
                for (const e of sorted) {
                    if (!platforms[e.platform]) platforms[e.platform] = {};
                    if (!platforms[e.platform][e.botId]) platforms[e.platform][e.botId] = [];
                    platforms[e.platform][e.botId].push(e.sid);
                }
                const lines: string[] = ['【公开会话目录】'];
                for (const platform of Object.keys(platforms).sort()) {
                    lines.push(`${platform}：`);
                    for (const botId of Object.keys(platforms[platform]).sort()) {
                        lines.push(botId);
                        for (const sid of platforms[platform][botId]) lines.push(`  ${sid}`);
                    }
                }
                seal.replyToSender(ctx, msg, lines.join('\n'));
                return ret;
            }
            case 'add': {
                const title = ctx.isPrivate
                    ? (ctx.player && ctx.player.name) || ''
                    : (ctx.group && ctx.group.groupName) || '';
                try {
                    const entry = publishCurrentSession({
                        ctx,
                        sid,
                        title,
                        addedBy: ctx.player ? ctx.player.userId : '',
                    });
                    seal.replyToSender(ctx, msg,
                        `已公开当前会话到目录: ${entry.platform} | ${entry.botId} | ${entry.sid} | ${entry.title || '(无标题)'}`);
                } catch (e) {
                    seal.replyToSender(ctx, msg, `公开会话失败: ${e instanceof Error ? e.message : String(e)}`);
                }
                return ret;
            }
            case 'rm':
            case 'remove': {
                const botId = ctx.endPoint && ctx.endPoint.userId ? ctx.endPoint.userId : '';
                const kwPlatform = cmdArgs.getKwarg('platform');
                const kwBot = cmdArgs.getKwarg('botid');
                const kwSession = cmdArgs.getKwarg('session');

                const hasFilter = !!(kwPlatform || kwBot || kwSession);
                if (!hasFilter) {
                    // 无参：移除当前会话条目
                    if (!botId || !sid) {
                        seal.replyToSender(ctx, msg, '无法获取当前会话（缺少端点或会话 ID）');
                        return ret;
                    }
                    const entry = getEntryBySession(botId, sid);
                    if (!entry) {
                        seal.replyToSender(ctx, msg, `当前会话未在目录中（${botId} / ${sid}）。用 .ai pub add 先公开。`);
                        return ret;
                    }
                    removeByFilters({ platform: entry.platform, botId: entry.botId, sid: entry.sid });
                    seal.replyToSender(ctx, msg, `已把当前会话移出目录: ${entry.sid}`);
                    return ret;
                }

                // 带过滤条件：交集删除命中条目（botId/会话ID 按目录存储的字符串原样匹配，不做格式假设）
                const platform = kwPlatform ? String(kwPlatform.value ?? '').trim() : '';
                const filterBot = kwBot ? String(kwBot.value ?? '').trim() : '';
                const filterSession = kwSession ? String(kwSession.value ?? '').trim() : '';
                const removed = removeByFilters({ platform: platform || undefined, botId: filterBot || undefined, sid: filterSession || undefined });
                if (removed === 0) {
                    seal.replyToSender(ctx, msg,
                        `目录中没有命中条目（platform=${platform || '*'}, botid=${filterBot || '*'}, session=${filterSession || '*'}）`);
                    return ret;
                }
                seal.replyToSender(ctx, msg, `已从目录删除 ${removed} 条会话条目。`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `未知操作: ${op}\n${helpText()}`);
                return ret;
            }
        }
    };
}
