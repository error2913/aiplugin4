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
        const { ctx, msg, ai, ret } = scc;
        const systemMessage = await buildSystemMessage(ctx, ai);
        logger.info(`system prompt:\n`, systemMessage.msgArray[0].text);
        seal.replyToSender(ctx, msg, systemMessage.msgArray[0].text);
        return ret;
    }
}
