// .ai ctx：上下文状态与管理（status/archive/hide/purge/set/name/repair）。
import { PRIVILEGE_LEVEL_MAP } from "../../config/static_config";
import { ctxHelpText, parseCtxCommand, runCtxCommand } from "../../context/commands";
import { compactionRuntimeFor } from "../../context/compact/session_runtime";
import type { ConversationEvent } from "../../context/events";
import { ContextService } from "../../context/service";
import { estimateEventTokens } from "../../utils/token_estimate";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 与 SessionService 打开新会话时同口径的事件 token 估算（purge 重建 service 时保持一致） */
const storeEstimate = (event: ConversationEvent) => estimateEventTokens(event);

export function registerCmdCtx() {
    const cmd = new SubCmd('ctx');
    cmd.desc = '查看或整理当前会话的上下文';
    cmd.help = ctxHelpText();
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, epId, gid, session, ret } = scc;
        const service = session.contextV2;
        if (!service) {
            seal.replyToSender(ctx, msg, '上下文尚未就绪，请稍后重试');
            return ret;
        }

        const args = cmdArgs.args.slice(1).map(a => String(a || ''));
        if (cmdArgs.kwargs.some(k => k.name === 'yes' || k.name === 'y')) args.push('--yes');
        const parsed = parseCtxCommand(args);
        const level = ctx.privilegeLevel ?? 0;
        if (parsed.action === 'purge' && level < PRIVILEGE_LEVEL_MAP.master) {
            seal.replyToSender(ctx, msg, '权限不足：清除上下文仅骰主可执行');
            return ret;
        }
        if ((parsed.action === 'set' || parsed.action === 'name') && level < PRIVILEGE_LEVEL_MAP.inviter) {
            seal.replyToSender(ctx, msg, '权限不足：修改上下文设置需要邀请者以上');
            return ret;
        }

        let result;
        try {
            result = await runCtxCommand({
                sessionId: sid,
                service,
                args,
                session,
                epId,
                gid,
                // 自动摘要与手动 archive 共用同一 runtime（单飞/退避状态一致，避免同一批事件被并发摘要两次）
                runtime: compactionRuntimeFor(session),
            });
        } catch (error) {
            seal.replyToSender(ctx, msg, `上下文操作失败：${error instanceof Error ? error.message : String(error)}`);
            return ret;
        }
        if (result.purged) {
            try {
                const fresh = ContextService.openSync(sid, { estimateEventTokens: storeEstimate });
                session.contextV2 = fresh;
                session.context.initV2(fresh);
                session.ctxAutoSummaryBlockedUntil = 0;
                session.save();
            } catch {
                session.contextV2 = null;
                session.context.initV2(null);
            }
        }
        seal.replyToSender(ctx, msg, result.text);
        return ret;
    };
}
