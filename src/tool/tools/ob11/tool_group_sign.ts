// 群打卡工具
import { netExists, sendGroupSign } from "../../../utils/ob11";
import Tool from "../../tool";

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
    tool.sessionType = 'group';
    tool.solve = async (ctx, _, __, ___) => {
        if (ctx.isPrivate) {
            return `群打卡只能在群聊中使用`;
        }

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;
        const gid = ctx.group!.groupId;

        await sendGroupSign(epId, gid.replace(/^.+:/, ''));
        return `已发送群打卡`;
    }
}