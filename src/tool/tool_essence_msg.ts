import { logger } from "../AI/logger";
import { transformMsgIdBack } from "../utils/utils";
import { ToolInfo, Tool, ToolManager } from "./tool";

export function registerSetEssenceMsg() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'set_essence_msg',
            description: '设置指定消息为精华消息',
            parameters: {
                type: 'object',
                properties: {
                    msg_id: {
                        type: 'string',
                        description: '消息ID'
                    }
                },
                required: ['msg_id']
            }
        }
    };

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { msg_id } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            logger.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = epId.replace(/^.+:/, '');
            const memberInfo = await globalThis.http.getData(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') {
                return `你没有管理员权限`;
            }
        } catch (e) {
            logger.error(e);
            return `获取权限信息失败`;
        }

        try {
            const epId = ctx.endPoint.userId;
            await globalThis.http.getData(epId, `set_essence_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return `已将消息${msg_id}设置为精华消息`;
        } catch (e) {
            logger.error(e);
            return `设置精华消息失败`;
        }
    };

    ToolManager.toolMap[info.function.name] = tool;
}

//TODO: 查看精华消息列表、取消精华消息