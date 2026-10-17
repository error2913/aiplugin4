// .ai ctx：查看当前会话的上下文成本状态（冷/热状态、窗口占用、本会话调用次数、归档分片、缓存命中）
import Config from "../../config/config";
import { estimateContextMessagesTokens } from "../../context/context";
import { UsageManager } from "../../usage";
import { fmtDate } from "../../utils/string";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdCtx() {
    const cmd = new SubCmd('ctx');
    cmd.desc = '查看当前会话的上下文成本状态';
    cmd.help = `帮助:
【.ai ctx】查看冷/热状态、窗口与预算、本会话压缩/归档/评分调用次数、归档分片与缓存命中`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, session, ret } = scc;
        const now = Date.now();
        const state = session.stateOf(now);
        const idle = session.lastRelevantAt > 0 ? Math.floor(Math.max(0, now - session.lastRelevantAt) / 60000) : -1;
        const stats = session.ctxStats || { compression: 0, summarization: 0, judge: 0 };
        const { COLD_WINDOW_CHARS, MAX_CONTEXT_TOKENS } = Config.context;

        const purposes = Object.keys(UsageManager.purposeUsage);
        const usageLine = purposes.length === 0
            ? '无记录'
            : purposes.map(use => {
                const u = UsageManager.getPurposeUsage(use);
                return `${use} ${u.prompt_tokens + u.completion_tokens}`;
            }).join(' · ');
        const cache = UsageManager.getCacheUsage();
        const cacheLine = (cache.read || cache.write) > 0
            ? `命中 ${cache.read} · 写入 ${cache.write}（全局，token）`
            : '未上报（厂商未返回缓存字段）';

        const lines = [
            `[会话 ${sid}] 状态：${state}${idle >= 0 ? `（距上次相关活动 ${idle}m）` : '（尚无相关活动）'}`,
            `预算：${MAX_CONTEXT_TOKENS} token（未受限）· 冷态窗口：${COLD_WINDOW_CHARS} 字`,
            `上下文：${session.context.messages.length} 条消息 / 约 ${estimateContextMessagesTokens(session.context.messages)} token`,
            `归档：分片 ${session.archiveSeq}${session.lastArchivedAt ? ` · 上次 ${fmtDate(session.lastArchivedAt)}` : ''}`,
            `本会话调用：压缩 ${stats.compression} · 归档总结 ${stats.summarization} · 评分 ${stats.judge}`,
            `全局用途用量：${usageLine}`,
            `缓存：${cacheLine}`,
        ];
        seal.replyToSender(ctx, msg, lines.join('\n'));
        return ret;
    }
}
