import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool"

export function registerDrawDeck() {
    const { decks } = ConfigManager.tool;
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "draw_deck",
            description: `用牌堆名称抽取牌堆，返回抽取结果，牌堆的名字有:${decks.join('、')}`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: "牌堆名称"
                    }
                },
                required: ["name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, _, args) => {
        const { name } = args;

        const dr = seal.deck.draw(ctx, name, true);
        if (!dr.exists) {
            logger.error(`牌堆${name}不存在:${dr.err}`);
            return `牌堆${name}不存在:${dr.err}`;
        }

        const result = dr.result;
        if (result == null) {
            logger.error(`牌堆${name}结果为空:${dr.err}`);
            return `牌堆${name}结果为空:${dr.err}`;
        }

        seal.replyToSender(ctx, msg, result);
        return result;
    }

    ToolManager.toolMap[info.function.name] = tool;
}