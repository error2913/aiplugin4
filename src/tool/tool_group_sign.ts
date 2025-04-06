import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerGroupSign() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.type = 'group';
    tool.solve = async (ctx, _, __, ___) => {
        if (ctx.isPrivate) {
            return `群打卡只能在群聊中使用`; 
        }

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            logger.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            await globalThis.http.getData(epId, `send_group_sign?group_id=${group_id.replace(/\D+/, '')}`);
            return `已发送群打卡，若无响应可能今日已打卡`;
        } catch (e) {
            logger.error(e);
            return `发送群打卡失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}