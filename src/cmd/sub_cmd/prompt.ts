// .ai prompt：查看当前 system prompt
import { logger } from "../../logger";
import { buildSystemMessage } from "../../utils/message";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdPrompt() {
    const cmd = new SubCmd('prompt');
    cmd.desc = '查看system prompt';
    cmd.help = `帮助:
【.ai prompt】查看当前 system prompt，内容过长时仅记录到日志`;
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, session, ret } = scc;
        const systemMessage = await buildSystemMessage(ctx, session);
        const text = (systemMessage.contentItems || [])[0]?.text || '';
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
