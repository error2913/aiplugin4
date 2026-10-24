// .ai ctx：Context v2 的统一入口（status/archive/hide/purge/set/name/repair）。
// 旧会话未接入 v2 时保留原成本状态输出，保证可回退。
import Config from "../../config/config";
import { PRIVILEGE_LEVEL_MAP } from "../../config/static_config";
import { parseCtxCommand, runCtxCommand } from "../../context/commands";
import { CompactionRuntime } from "../../context/compact/runtime";
import { estimateContextMessagesTokens } from "../../context/context";
import type { ConversationEvent } from "../../context/events";
import type { ContextService } from "../../context/service";
import { getAuxLlm } from "../../core/ports/aux_llm";
import { UsageManager } from "../../usage";
import { fmtDate } from "../../utils/string";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

function estimateEventTokens(event: ConversationEvent): number {
    const parts = (event as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
    let chars = 0;
    for (const part of parts) if (part.type === 'text') chars += String(part.text ?? '').length;
    if (event.kind === 'tool_call') chars += String(event.args ?? '').length;
    return Math.max(1, Math.ceil(chars / 3)) + 4;
}

function buildRuntime(service: ContextService): CompactionRuntime {
    return new CompactionRuntime(
        { watermarkTokens: 0, batchTokens: 6000, summaryMaxChars: 2000, hourlyCap: 6 },
        {
            service,
            summarize: async (text: string) => {
                try {
                    const out = await getAuxLlm().chat('summarize_agent', text);
                    return typeof out === 'string' && out.trim() ? out : null;
                } catch {
                    return null;
                }
            },
            estimateEventTokens,
        },
    );
}

export function registerCmdCtx() {
    const cmd = new SubCmd('ctx');
    cmd.desc = '查看/整理当前会话上下文（Context v2）';
    cmd.help = `帮助:
【.ai ctx】查看上下文体积/积压（短）
【.ai ctx archive】生成/刷新摘要（不删原文、不写记忆）
【.ai ctx hide [user|assistant|all]】逻辑遗忘
【.ai ctx purge --yes】物理清除本会话上下文（骰主）
【.ai ctx repair】检查/修复 head`;
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, session, ret } = scc;
        const v2 = session.contextV2;

        if (v2) {
            const args = cmdArgs.args.slice(1).map(a => String(a || ''));
            const parsed = parseCtxCommand(args);
            const master = (ctx.privilegeLevel ?? 0) >= PRIVILEGE_LEVEL_MAP.master;
            if (parsed.action === 'purge' && !master) {
                seal.replyToSender(ctx, msg, '权限不足：purge 仅骰主可执行');
                return ret;
            }
            const runtime = buildRuntime(v2);
            const result = await runCtxCommand({ sessionId: sid, service: v2, args, runtime });
            seal.replyToSender(ctx, msg, result.text);
            return ret;
        }

        // 未接入 v2（迁移失败/旧会话回退）：保留原成本状态
        const now = Date.now();
        const state = session.stateOf(now, { touch: false });
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
        const rawSeq = (session as any).rawSeq || 0;
        const settledSeq = (session as any).settledSeq || 0;
        const lines = [
            `[会话 ${sid}] 状态：${state}${idle >= 0 ? `（距上次相关活动 ${idle}m）` : '（尚无相关活动）'}`,
            `预算：${MAX_CONTEXT_TOKENS} token（未受限）· 冷态窗口：${COLD_WINDOW_CHARS} 字 · 窗口上限：${Config.context.WINDOW_MAX_CHARS} 字`,
            `上下文：${session.context.messages.length} 条消息 / 约 ${estimateContextMessagesTokens(session.context.messages)} token`,
            `归档：分片 ${session.archiveSeq}${session.lastArchivedAt ? ` · 上次 ${fmtDate(session.lastArchivedAt)}` : ''}`,
            `窗口移出：分片 ${rawSeq}${session.lastRawAt ? ` · 上次 ${fmtDate(session.lastRawAt)}` : ''} · 已结算到 ${settledSeq}/${rawSeq}`,
            `本会话调用：压缩 ${stats.compression} · 归档总结 ${stats.summarization} · 评分 ${stats.judge}`,
            `全局用途用量：${usageLine}`,
            `缓存：${cacheLine}`,
        ];
        seal.replyToSender(ctx, msg, lines.join('\n'));
        return ret;
    };
}
