// 牌堆工具：抽取牌堆
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Tool from "../../tool"

export function registerDeck() {
    const { DECKS: decks } = Config.tool;

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
                    },
                    send: {
                        type: 'boolean',
                        description: "是否直接将抽牌结果发送给用户：true 时直接发送原始抽牌结果；false 或省略时返回结果由你转述，可结合剧情再加工"
                    }
                },
                required: ["name"]
            }
        }
    });
    toolDraw.solve = async (ctx, msg, _, args) => {
        const { name, send = false } = args;

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

        if (send) {
            seal.replyToSender(ctx, msg, result);
        }
        return result;
    }
}
