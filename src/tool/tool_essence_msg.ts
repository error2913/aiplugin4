import { logger } from "../logger";
import { transformMsgIdBack, transformMsgId } from "../utils/utils";
import { Tool } from "./tool";
import { ConfigManager } from "../config/config";
import { Image, ImageManager } from "../AI/image";

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
    toolGet.solve = async (ctx, _, __, ___) => {
        if (ctx.isPrivate) {
            return `精华消息功能仅在群聊中可用`;
        }

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return `未找到ob11网络连接依赖，请提示用户安装`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const result = await net.callApi(epId, `get_essence_msg_list?group_id=${group_id}`);
            
            if (!Array.isArray(result) || result.length === 0) {
                return `该群暂无精华消息`;
            }

            let response = `群精华消息列表 (${result.length}条):\n\n`;
            
            for (let i = 0; i < result.length; i++) {
                const essence = result[i];
                const addTime = new Date(essence.operator_time * 1000).toLocaleString();
                const operatorName = essence.operator_nick || `用户${essence.operator_id}`;
                const senderName = essence.sender_nick || `用户${essence.sender_id}`;
                const msgId = transformMsgId(essence.message_id);
                
                response += `${i + 1}. 发送者: ${senderName}\n`;
                response += `   操作者: ${operatorName}\n`;
                response += `   设置时间: ${addTime}\n`;
                response += `   消息ID: ${msgId}\n`;
                
                if (essence.content) {
                    let content = '';
                    if (Array.isArray(essence.content)) {
                        for (const item of essence.content) {
                            if (item.type === 'text') {
                                content += item.data.text;
                            } else if (item.type === 'image') {
                                const imageUrl = item.data.url;
                                if (imageUrl) {
                                    const image = new Image(imageUrl);

                                    if (image.isUrl) {
                                        const { condition } = ConfigManager.image;

                                        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
                                        if (fmtCondition === 1) {
                                            const reply = await ImageManager.imageToText(imageUrl);
                                            if (reply) {
                                                image.content = reply;
                                                content += `<|img:${image.id}:${reply}|>`;
                                            }
                                        } else {
                                            content += `<|img:${image.id}|>`;
                                        }
                                    }                              
                                }
                            }
                        }
                    } else if (typeof essence.content === 'string') {
                        content = essence.content;
                    }
                    
                    if (content.length > 50) {
                        content = content.substring(0, 50) + '...';
                    }
                    response += `   内容: ${content}\n`;
                }
                
                response += '\n';
            }
            
            return response.trim();
        } catch (e) {
            logger.error(e);
            return `获取精华消息列表失败: ${e.message}`;
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
            return `精华消息功能仅在群聊中可用`;
        }

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
            await net.callApi(epId, `delete_essence_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return `已删除精华消息 ${msg_id}`;
        } catch (e) {
            logger.error(e);
            return `删除精华消息失败: ${e.message}`;
        }
    };
}