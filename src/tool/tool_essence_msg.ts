import { logger } from "../logger";
import { transformMsgIdBack } from "../utils/utils";
import { Tool } from "./tool";

export function registerEssenceMsg() {
    const toolSet = new Tool({
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
    });
    toolSet.solve = async (ctx, _, __, args) => {
        const { msg_id } = args;

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return `未找到ob11网络连接依赖，请提示用户安装`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = epId.replace(/^.+:/, '');
            const memberInfo = await net.callApi(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') {
                return `你没有管理员权限`;
            }
        } catch (e) {
            logger.error(e);
            return `获取权限信息失败`;
        }

        try {
            const epId = ctx.endPoint.userId;
            await net.callApi(epId, `set_essence_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return `已将消息${msg_id}设置为精华消息`;
        } catch (e) {
            logger.error(e);
            return `设置精华消息失败`;
        }
    };
}

//TODO: 查看精华消息列表、取消精华消息