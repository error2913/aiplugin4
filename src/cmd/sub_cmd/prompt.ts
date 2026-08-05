// .ai prompt：查看当前 system prompt
import { logger } from "../../logger";
import { buildSystemMessage } from "../../utils/message";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdPrompt() {
    const cmd = new SubCmd('prompt');
    cmd.desc = '查看system prompt';
    cmd.help = '';
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, session, ret } = scc;
        const systemMessage = await buildSystemMessage(ctx, session);
        const text = systemMessage.contentItems[0].text;
        logger.info(`system prompt:\n`, text);
        seal.replyToSender(ctx, msg, text);
        return ret;
    }
}
