import { AIManager } from "../AI/AI";
import { Image, ImageManager } from "../AI/image";
import { logger } from "../logger";
import { ConfigManager, CQTYPESALLOW } from "../config/config";
import { replyToSender, transformMsgId, transformMsgIdBack } from "../utils/utils";
import { createCtx, createMsg } from "../utils/utils_seal";
import { handleReply, MessageSegment, transformTextToArray } from "../utils/utils_string";
import { Tool, ToolManager } from "./tool";

export function registerMessage() {
    const toolSend = new Tool({
        type: "function",
        function: {
            name: "send_msg",
            description: `向当前聊天以外的指定私聊或群聊发送消息或调用函数`,
            parameters: {
                type: "object",
                properties: {
                    msg_type: {
                        type: "string",
                        description: "消息类型，私聊或群聊",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与消息类型对应'
                    },
                    content: {
                        type: 'string',
                        description: '消息内容'
                    },
                    function: {
                        type: "string",
                        description: '函数调用，纯JSON字符串，格式为：{"name": "函数名称", "arguments": {"参数1": "值1", "参数2": "值2"}}'
                    },
                    reason: {
                        type: 'string',
                        description: '发送原因'
                    }
                },
                required: ["msg_type", "name", "content"]
            }
        }
    });
    toolSend.solve = async (ctx, msg, ai, args) => {
        const { msg_type, name, content, function: tool_call, reason = '' } = args;

        const { showNumber } = ConfigManager.message;
        const source = ctx.isPrivate ?
            `来自<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/^.+:/, '')})` : ``}` :
            `来自群聊<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/^.+:/, '')})` : ``}`;

        const originalImages = [];
        const match = content.match(/[<＜][\|│｜]img:.+?(?:[\|│｜][>＞]|[\|│｜>＞])/g);
        if (match) {
            for (let i = 0; i < match.length; i++) {
                const id = match[i].match(/[<＜][\|│｜]img:(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/)[1].trim().slice(0, 6);
                const image = ai.context.findImage(id, ai);

                if (image) {
                    originalImages.push(image);
                }
            }
        }

        if (msg_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }
            if (uid === ctx.player.userId && ctx.isPrivate) {
                return { content: `向当前私聊发送消息无需调用函数`, images: [] };
            }
            if (uid === ctx.endPoint.userId) {
                return { content: `禁止向自己发送消息`, images: [] };
            }

            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (msg_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }
            if (gid === ctx.group.groupId) {
                return { content: `向当前群聊发送消息无需调用函数`, images: [] };
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
        } else {
            return { content: `未知的消息类型<${msg_type}>`, images: [] };
        }

        ai.resetState();

        await ai.context.addSystemUserMessage("来自其他对话的消息发送提示", `${source}: 原因: ${reason || '无'}`, originalImages);

        const { contextArray, replyArray, images } = await handleReply(ctx, msg, ai, content);

        try {
            for (let i = 0; i < contextArray.length; i++) {
                const s = contextArray[i];
                const messageArray = transformTextToArray(s);
                const reply = replyArray[i];
                const msgId = await replyToSender(ctx, msg, ai, reply);
                await ai.context.addMessage(ctx, msg, ai, messageArray, images, 'assistant', msgId);
            }

            if (tool_call) {
                try {
                    await ToolManager.handlePromptToolCall(ctx, msg, ai, tool_call);
                } catch (e) {
                    logger.error(`在handlePromptToolCall中出错：`, e.message);
                    return { content: `函数调用失败:${e.message}`, images: [] };
                }
            }

            AIManager.saveAI(ai.id);
            return { content: "消息发送成功", images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `消息发送失败:${e.message}`, images: [] };
        }
    }

    const toolGet = new Tool({
        type: 'function',
        function: {
            name: 'get_msg',
            description: '获取指定消息',
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
    toolGet.solve = async (ctx, _, ai, args) => {
        const { msg_id } = args;
        const { isPrefix, showNumber, showMsgId } = ConfigManager.message;

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const result = await net.callApi(epId, `get_msg?message_id=${transformMsgIdBack(msg_id)}`);
            let messageArray: MessageSegment[] = result.message.filter((item: MessageSegment) => item.type === 'text' && !CQTYPESALLOW.includes(item.type));

            // 图片偷取，以及图片转文字
            const images: Image[] = [];
            if (messageArray.some(item => item.type === 'image')) {
                const result = await ImageManager.handleImageMessage(ctx, messageArray);
                messageArray = result.messageArray;
                images.push(...result.images);
                if (ai.imageManager.stealStatus) {
                    ai.imageManager.stealImages(images);
                }
            }

            //处理文本
            const message = messageArray.map(item => {
                switch (item.type) {
                    case 'text': {
                        return item.data.text;
                    }
                    case 'at': {
                        const epId = ctx.endPoint.userId;
                        const gid = ctx.group.groupId;
                        const uid = `QQ:${item.data.qq || ''}`;
                        const mmsg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
                        const mctx = createCtx(epId, mmsg);
                        const name = mctx.player.name || '未知用户';

                        return `<|at:${name}${showNumber ? `(${uid.replace(/^.+:/, '')})` : ``}|>`;
                    }
                    case 'poke': {
                        const epId = ctx.endPoint.userId;
                        const gid = ctx.group.groupId;
                        const uid = `QQ:${item.data.qq || ''}`;
                        const mmsg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
                        const mctx = createCtx(epId, mmsg);
                        const name = mctx.player.name || '未知用户';

                        return `<|poke:${name}${showNumber ? `(${uid.replace(/^.+:/, '')})` : ``}|>`;
                    }
                    case 'reply': {
                        return showMsgId ? `<|quote:${transformMsgId(item.data.id || '')}|>` : ``;
                    }
                    default: {
                        return '';
                    }
                }
            }).join('');

            const gid = ctx.group.groupId;
            const uid = `QQ:${result.sender.user_id}`;
            const mmsg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
            const mctx = createCtx(epId, mmsg);
            const name = mctx.player.name || '未知用户';
            const prefix = isPrefix ? `<|from:${name}${showNumber ? `(${uid.replace(/^.+:/, '')})` : ``}|>` : '';

            return { content: prefix + message, images: images };
        } catch (e) {
            logger.error(e);
            return { content: `获取消息信息失败`, images: [] };
        }
    }

    const toolDel = new Tool({
        type: 'function',
        function: {
            name: 'delete_msg',
            description: '撤回指定消息',
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
    toolDel.solve = async (ctx, _, __, args) => {
        const { msg_id } = args;

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            const result = await net.callApi(epId, `get_msg?message_id=${transformMsgIdBack(msg_id)}`);
            if (result.sender.user_id != epId.replace(/^.+:/, '')) {
                if (result.sender.role == 'owner' || result.sender.role == 'admin') {
                    return { content: `你没有权限撤回该消息`, images: [] };
                }

                try {
                    const epId = ctx.endPoint.userId;
                    const group_id = ctx.group.groupId.replace(/^.+:/, '');
                    const user_id = epId.replace(/^.+:/, '');
                    const result = await net.callApi(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
                    if (result.role !== 'owner' && result.role !== 'admin') {
                        return { content: `你没有管理员权限`, images: [] };
                    }
                } catch (e) {
                    logger.error(e);
                    return { content: `获取权限信息失败`, images: [] };
                }
            }
        } catch (e) {
            logger.error(e);
            return { content: `获取消息信息失败`, images: [] };
        }

        try {
            const epId = ctx.endPoint.userId;
            await net.callApi(epId, `delete_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return { content: `已撤回消息${msg_id}`, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `撤回消息失败`, images: [] };
        }
    }
}