import { logger } from "../logger";
import { Tool } from "./tool";

export function registerGroupSign() {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'group_sign',
            description: '发送群打卡',
            parameters: {
                type: 'object',
                properties: {
                },
                required: []
            }
        }
    });
    tool.type = 'group';
    tool.solve = async (ctx, _, __, ___) => {
        if (ctx.isPrivate) {
            return { content: `群打卡只能在群聊中使用`, images: [] };
        }

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            await net.callApi(epId, `send_group_sign?group_id=${group_id.replace(/^.+:/, '')}`);
            return { content: `已发送群打卡，若无响应可能今日已打卡`, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `发送群打卡失败`, images: [] };
        }
    }
}