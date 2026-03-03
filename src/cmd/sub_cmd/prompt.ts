import { logger } from "../../logger";
import { buildSystemMessage } from "../../utils/utils_message";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function getCmdPrompt(): SubCmd {
    const cmd = new SubCmd('prompt');
    cmd.help = '';
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ai, ret } = scc;
        const systemMessage = await buildSystemMessage(ctx, ai);
        logger.info(`system prompt:\n`, systemMessage.msgArray[0].content);
        seal.replyToSender(ctx, msg, systemMessage.msgArray[0].content);
        return ret;
    }

    return cmd;
}
