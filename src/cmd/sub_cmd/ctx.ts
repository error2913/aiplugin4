// .ai ctx：上下文状态与管理（status/archive/hide/purge/set/name/repair）。
import { PRIVILEGE_LEVEL_MAP } from "../../config/static_config";
import { ctxHelpText, parseCtxCommand, runCtxCommand } from "../../context/commands";
import { CompactionRuntime } from "../../context/compact/runtime";
import type { ConversationEvent } from "../../context/events";
import { ContextService } from "../../context/service";
import { getAuxLlm } from "../../core/ports/aux_llm";
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
        { watermarkTokens: 0, batchTokens: 6000, summaryMaxChars: 2000, hourlyCap: 0 },
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

        const result = await runCtxCommand({
            sessionId: sid,
            service,
            args,
            session,
            epId,
            gid,
            runtime: parsed.action === 'archive' ? buildRuntime(service) : null,
        });
        if (result.purged) {
            const fresh = ContextService.openSync(sid);
            session.contextV2 = fresh;
            session.context.initV2(fresh);
            session.save();
        }
        seal.replyToSender(ctx, msg, result.text);
        return ret;
    };
}
