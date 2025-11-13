import { transformMsgIdBack, transformMsgId } from "../utils/utils";
import { Tool } from "./tool";
import { Image } from "../AI/image";
import { transformArrayToContent } from "../utils/utils_string";
import { deleteEssenceMsg, getEssenceMsgList, getGroupMemberInfo, netExists, setEssenceMsg } from "../utils/utils_ob11";

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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
        if (!memberInfo) return { content: `获取权限信息失败`, images: [] };
        if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return { content: `你没有管理员权限`, images: [] };

        await setEssenceMsg(epId, transformMsgIdBack(msg_id));
        return { content: `已将消息${msg_id}设置为精华消息`, images: [] };
    }

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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        const essenceMsgList = await getEssenceMsgList(epId, gid.replace(/^.+:/, ''));
        if (!essenceMsgList || !Array.isArray(essenceMsgList)) return { content: `获取群 ${gid} 精华消息列表失败`, images: [] };

        if (essenceMsgList.length === 0) return { content: `该群暂无精华消息`, images: [] };

        let s = `群精华消息列表 (${essenceMsgList.length}条):\n`;
        const images: Image[] = [];

        for (let i = 0; i < essenceMsgList.length; i++) {
            const essence = essenceMsgList[i];
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

                if (content.length > 50) content = content.substring(0, 100) + '...';

                s += `${i + 1}. 发送者: ${senderName}
    操作者: ${operatorName}
    设置时间: ${addTime}
    消息ID: ${msgId}
    内容: ${content}\n`;
            }
        }

        return { content: s.trim(), images: images };
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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
        if (!memberInfo) return { content: `获取权限信息失败`, images: [] };
        if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return { content: `你没有管理员权限`, images: [] };

        await deleteEssenceMsg(epId, transformMsgIdBack(msg_id));
        return { content: `已删除精华消息 ${msg_id}`, images: [] };
    };
}