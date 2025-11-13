import { netExists, sendGroupSign } from "../utils/utils_ob11";
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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        await sendGroupSign(epId, gid.replace(/^.+:/, ''));
        return { content: `已发送群打卡`, images: [] };
    }
}