import { logger } from "../logger";
import { transformMsgIdBack, transformMsgId } from "../utils/utils";
import { Tool } from "./tool";
import { Image } from "../AI/image";
import { transformArrayToContent } from "../utils/utils_string";

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
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = epId.replace(/^.+:/, '');
            const memberInfo = await net.callApi(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') {
                return { content: `你没有管理员权限`, images: [] };
            }
        } catch (e) {
            logger.error(e);
            return { content: `获取权限信息失败`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            await net.callApi(epId, `set_essence_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return { content: `已将消息${msg_id}设置为精华消息`, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `设置精华消息失败`, images: [] };
        }
    };

    const toolGet = new Tool({
        type: 'function',
        function: {
            name: 'get_essence_msg_list',
            description: '获取群精华消息列表',
            parameters: {
                type: 'object',
                properties: {
                },
                required: []
            }
        }
    });
    toolGet.solve = async (ctx, _, ai, __) => {
        if (ctx.isPrivate) {
            return { content: `精华消息功能仅在群聊中可用`, images: [] };
        }

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const result = await net.callApi(epId, `get_essence_msg_list?group_id=${group_id}`);

            if (!Array.isArray(result) || result.length === 0) {
                return { content: `该群暂无精华消息`, images: [] };
            }

            let response = `群精华消息列表 (${result.length}条):\n\n`;
            const images: Image[] = [];

            for (let i = 0; i < result.length; i++) {
                const essence = result[i];
                const addTime = new Date(essence.operator_time * 1000).toLocaleString();
                const operatorName = essence.operator_nick || `用户${essence.operator_id}`;
                const senderName = essence.sender_nick || `用户${essence.sender_id}`;
                const msgId = transformMsgId(essence.message_id);

                if (essence.content) {
                    let content = '';
                    if (Array.isArray(essence.content)) {
                        const result = await transformArrayToContent(ctx, ai, essence.content);
                        content = result.content;
                        images.push(...result.images);
                    } else if (typeof essence.content === 'string') {
                        content = essence.content;
                    }

                    if (content.length > 50) {
                        content = content.substring(0, 100) + '...';
                    }

                    response += `${i + 1}. 发送者: ${senderName}
    操作者: ${operatorName}
    设置时间: ${addTime}
    消息ID: ${msgId}
    内容: ${content}\n`;
                }
            }

            return { content: response.trim(), images: images };
        } catch (e) {
            logger.error(e);
            return { content: `获取精华消息列表失败: ${e.message}`, images: [] };
        }
    };

    const toolDel = new Tool({
        type: 'function',
        function: {
            name: 'delete_essence_msg',
            description: '删除群精华消息',
            parameters: {
                type: 'object',
                properties: {
                    msg_id: {
                        type: 'string',
                        description: '要删除的精华消息ID'
                    }
                },
                required: ['msg_id']
            }
        }
    });
    toolDel.solve = async (ctx, _, __, args) => {
        const { msg_id } = args;

        if (ctx.isPrivate) {
            return { content: `精华消息功能仅在群聊中可用`, images: [] };
        }

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = epId.replace(/^.+:/, '');
            const memberInfo = await net.callApi(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') {
                return { content: `你没有管理员权限`, images: [] };
            }
        } catch (e) {
            logger.error(e);
            return { content: `获取权限信息失败`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            await net.callApi(epId, `delete_essence_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return { content: `已删除精华消息 ${msg_id}`, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `删除精华消息失败: ${e.message}`, images: [] };
        }
    };
}