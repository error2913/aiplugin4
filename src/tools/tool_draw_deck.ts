import { ConfigManager } from "../utils/configUtils";
import { Tool, ToolInfo, ToolManager } from "./tool"

export function registerDrawDeck() {
    const { decks } = ConfigManager.getDeckConfig();
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
    tool.solve = async (ctx, msg, _, name) => {
        const dr = seal.deck.draw(ctx, name, true);
        if (!dr.exists) {
            console.error(`牌堆${name}不存在:${dr.err}`);
            return `牌堆${name}不存在:${dr.err}`;
        }

        const result = dr.result;
        if (result == null) {
            console.error(`牌堆${name}结果为空:${dr.err}`);
            return `牌堆${name}结果为空:${dr.err}`;
        }

        seal.replyToSender(ctx, msg, result);
        return result;
    }

    ToolManager.toolMap[info.function.name] = tool;
}