// .ai prompt：查看当前 system prompt 与段统计
import { logger } from "../../logger";
import { renderSectionTable } from "../../prompt/assemble";
import { buildPromptParts } from "../../prompt/builder";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdPrompt() {
    const cmd = new SubCmd('prompt');
    cmd.desc = '查看system prompt';
    cmd.help = `帮助:
【.ai prompt】查看当前 system prompt 与 runtime 段，内容过长时仅记录到日志
【.ai prompt sections】查看 prompt 段统计（order/name/channel/chars/tokens/cache）`;
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const parts = await buildPromptParts(ctx, session);
        if (cmdArgs.getArgN(2) === 'sections') {
            const table = renderSectionTable(parts);
            logger.logLong(`system prompt sections`, table);
            seal.replyToSender(ctx, msg, table.length <= 1500 ? table : `段统计过长（${table.length} 字符），已记录到海豹日志`);
            return ret;
        }

        const text = parts.runtime
            ? `${parts.system}\n\n--- runtime ---\n${parts.runtime}`
            : parts.system;
        logger.logLong(`system prompt`, text);
        const MAX_PROMPT_OUTPUT_LENGTH = 500;
        if (text.length > MAX_PROMPT_OUTPUT_LENGTH) {
            seal.replyToSender(ctx, msg, `system prompt 过长（${text.length} 字符），未发送，已记录到海豹日志`);
        } else {
            seal.replyToSender(ctx, msg, text);
        }
        return ret;
    }
}
