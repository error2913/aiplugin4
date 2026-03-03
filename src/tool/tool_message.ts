import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { replyToSender, transformMsgIdBack } from "../utils/utils";
import { getCtxAndMsg } from "../utils/utils_seal";
import { handleReply, MessageSegment, parseSpecialTokens, transformArrayToContent } from "../utils/utils_string";
import { Tool, ToolManager } from "./tool";
import { CQTYPESALLOW, faceMap } from "../config/config";
import { deleteMsg, getGroupMemberInfo, getMsg, sendGroupForwardMsg, sendPrivateForwardMsg, netExists } from "../utils/utils_ob11";
import { logger } from "../logger";
import { Image } from "../AI/image";

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

        const segs = parseSpecialTokens(content);
        const originalImages: Image[] = [];
        for (const seg of segs) {
            switch (seg.type) {
                case 'img': {
                    const id = seg.content;
                    const image = await ai.context.findImage(ctx, id);
                    if (image) originalImages.push(image);
                    else logger.warning(`无法找到图片：${id}`);
                    break;
                }
            }
        }

        if (msg_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };
            if (ui.id === ctx.player.userId && ctx.isPrivate) return { content: `向当前私聊发送消息无需调用函数`, images: [] };
            if (ui.id === ctx.endPoint.userId) return { content: `禁止向自己发送消息`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (msg_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };
            if (gi.id === ctx.group.groupId) return { content: `向当前群聊发送消息无需调用函数`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
        } else {
            return { content: `未知的消息类型<${msg_type}>`, images: [] };
        }

        ai.resetState();

        await ai.context.addSystemUserMessage("来自其他对话的消息发送提示", `${source}: 原因: ${reason || '无'}`, originalImages);

        const { contextArray, replyArray, images } = await handleReply(ctx, msg, ai, content);

        for (let i = 0; i < contextArray.length; i++) {
            const content = contextArray[i];
            const reply = replyArray[i];
            const msgId = await replyToSender(ctx, msg, ai, reply);
            await ai.context.addMessage(ctx, msg, ai, content, images, 'assistant', msgId);
        }

        if (tool_call) await ToolManager.handlePromptToolCall(ctx, msg, ai, tool_call);

        AIManager.saveAI(ai.id);
        return { content: "消息发送成功", images: [] };
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
        const { isPrefix, showNumber } = ConfigManager.message;

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;

        const result = await getMsg(epId, transformMsgIdBack(msg_id));
        if (!result) return { content: `获取消息 ${msg_id} 失败`, images: [] };
        const messageArray: MessageSegment[] = result.message.filter((item: MessageSegment) => item.type === 'text' && !CQTYPESALLOW.includes(item.type));

        const { content, images } = await transformArrayToContent(ctx, ai, messageArray);

        const gid = ctx.group.groupId;
        const uid = `QQ:${result.sender.user_id}`;
        ({ ctx } = getCtxAndMsg(epId, uid, gid));
        const name = ctx.player.name || '未知用户';
        const prefix = isPrefix ? `<|from:${name}${showNumber ? `(${uid.replace(/^.+:/, '')})` : ``}|>` : '';

        return { content: prefix + content, images: images };
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

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;

        const result = await getMsg(epId, transformMsgIdBack(msg_id));
        if (!result) return { content: `获取消息 ${msg_id} 失败`, images: [] };
        if (result.sender.user_id != epId.replace(/^.+:/, '')) {
            if (result.sender.role == 'owner' || result.sender.role == 'admin') {
                return { content: `你没有权限撤回该消息`, images: [] };
            }

            const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), epId.replace(/^.+:/, ''));
            if (!memberInfo) return { content: `获取权限信息失败`, images: [] };
            if (memberInfo.role !== 'owner' && memberInfo.role !== 'admin') return { content: `你没有管理员权限`, images: [] };
        }

        await deleteMsg(epId, transformMsgIdBack(msg_id));
        return { content: `已撤回消息${msg_id}`, images: [] };
    }

    const toolMerge = new Tool({
        type: 'function',
        function: {
            name: 'send_forward_msg',
            description: '发送合并转发消息',
            parameters: {
                type: 'object',
                properties: {
                    msg_type: {
                        type: 'string',
                        description: '消息类型，私聊或群聊',
                        enum: ['private', 'group']
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与消息类型对应'
                    },
                    messages: {
                        type: 'array',
                        description: '消息节点列表，可以有多个',
                        items: {
                            type: 'object',
                            properties: {
                                name: {
                                    type: 'string',
                                    description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                                },
                                nickname: {
                                    type: 'string',
                                    description: '发送者名称，默认与name相同'
                                },
                                content: {
                                    type: 'string',
                                    description: '消息内容'
                                }
                            },
                            required: ['content']
                        }
                    }
                },
                required: ['msg_type', 'name', 'messages']
            }
        }
    });
    toolMerge.solve = async (ctx, _, ai, args) => {
        const { msg_type, name, messages } = args;

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const messagesToSend = [];
        const images: Image[] = [];
        const randomId = Math.floor(Math.random() * 1000000000);
        let unknowUserArray: string[] = [];
        for (const messageItem of messages) {
            const segs = parseSpecialTokens(messageItem.content);
            const content: MessageSegment[] = [];
            for (const seg of segs) {
                switch (seg.type) {
                    case 'text': {
                        content.push({
                            type: 'text',
                            data: {
                                text: seg.content
                            }
                        })
                        break;
                    }
                    case 'at': {
                        const name = seg.content;
                        const ui = await ai.context.findUserInfo(ctx, name);
                        if (ui !== null) {
                            content.push({
                                type: 'at',
                                data: {
                                    qq: ui.id.replace(/^.+:/, "")
                                }
                            })
                        } else {
                            logger.warning(`无法找到用户：${name}`);
                            content.push({
                                type: 'text',
                                data: {
                                    text: ` @${name} `
                                }
                            })
                        }
                        break;
                    }
                    case 'quote': {
                        const msgId = seg.content;
                        content.push({
                            type: 'reply',
                            data: { id: String(transformMsgIdBack(msgId)) }
                        })
                        break;
                    }
                    case 'img': {
                        const id = seg.content;
                        const image = await ai.context.findImage(ctx, id);

                        if (image) {
                            if (image.type === 'local') break;
                            images.push(image);
                            content.push({
                                type: 'image',
                                data: { file: image.type === 'base64' ? seal.base64ToImage(image.base64) : image.file }
                            })
                        } else {
                            logger.warning(`无法找到图片：${id}`);
                        }
                        break;
                    }
                    case 'face': {
                        const faceId = Object.keys(faceMap).find(key => faceMap[key] === seg.content) || '';
                        content.push({
                            type: 'face',
                            data: { id: faceId }
                        })
                        break;
                    }
                }
            }

            if (content.length === 0) {
                return { content: `消息长度不能为0`, images: [] };
            }

            let userId = '';
            let name = '';
            const ui = await ai.context.findUserInfo(ctx, messageItem.name, true);
            if (ui !== null) {
                userId = ui.id.replace(/^.+:/, "");
                name = ui.name;
            } else {
                let unknowUserIndex = unknowUserArray.indexOf(messageItem.name);
                if (unknowUserIndex === -1) {
                    unknowUserIndex = unknowUserArray.length;
                    unknowUserArray.push(messageItem.name);
                }
                userId = String(unknowUserIndex + randomId);
                name = `未知用户${unknowUserIndex + 1}`;
            }

            messagesToSend.push({
                type: 'node',
                data: {
                    user_id: userId,
                    nickname: messageItem.nickname || name,
                    content: content
                }
            });
        }

        const news = null;
        const prompt = "";
        const summary = "";
        const source = "";

        if (msg_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };
            if (ui.id === ctx.endPoint.userId) return { content: `禁止向自己发送消息`, images: [] };

            await sendPrivateForwardMsg(ctx.endPoint.userId, ui.id.replace(/^.+:/, ""), messagesToSend, news, prompt, summary, source);
        } else if (msg_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };

            await sendGroupForwardMsg(ctx.endPoint.userId, gi.id.replace(/^.+:/, ""), messagesToSend, news, prompt, summary, source);
        } else {
            return { content: `未知的消息类型<${msg_type}>`, images: [] };
        }

        return { content: `发送合并消息成功`, images: images };
    }
}

// TODO: 合并消息嵌套