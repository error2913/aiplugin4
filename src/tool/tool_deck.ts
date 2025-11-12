import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool"

export function registerDeck() {
    const { decks } = ConfigManager.tool;

    const toolDraw = new Tool({
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
    });
    toolDraw.solve = async (ctx, msg, _, args) => {
        const { name } = args;

        const dr = seal.deck.draw(ctx, name, true);
        if (!dr.exists) {
            logger.error(`牌堆${name}不存在:${dr.err}`);
            return { content: `牌堆${name}不存在:${dr.err}`, images: [] };
        }

        const result = dr.result;
        if (result == null) {
            logger.error(`牌堆${name}结果为空:${dr.err}`);
            return { content: `牌堆${name}结果为空:${dr.err}`, images: [] };
        }

        seal.replyToSender(ctx, msg, result);
        return { content: result, images: [] };
    }
}