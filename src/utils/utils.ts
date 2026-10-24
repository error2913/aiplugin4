// 通用工具：回复发送（OB11 依赖优先 + 海豹原生兜底）。
// 消息 ID / ID 生成 / 指令别名 / 相似度 / 路径解析已拆到同目录叶子模块
// （message_id / id / alias / similarity / path）；停止事件与超时见 timeout.ts、revive 见 revive.ts。
// 消费方直接引用叶子模块，避免经由本文件拉进「utils → string → image → model → …」依赖环。
import Config from "../config/config";
import { logger } from "../logger";
import { callOb11ApiForContext } from "../transport/ob11/dispatcher";

import { transformMsgId } from "./message_id";
import { netExists } from "./ob11";
import { transformTextToArray } from "./string";

const sendLog = logger.withTag('send');
export async function replyToSender(ctx: seal.MsgContext, msg: seal.Message, session: { context: { lastReply: string } }, s: string): Promise<string> {
    if (!s) {
        return '';
    }

    const { showMsgId = true } = Config.context as any;
    if (showMsgId && netExists()) {
        try {
            const rawMessageArray = transformTextToArray(s);
            const messageArray = rawMessageArray.filter(item => item.type !== 'poke');

            // 处理戳戳戳
            const pokeMsgArr = rawMessageArray.filter(item => item.type === 'poke');
            if (pokeMsgArr.length > 0) {
                pokeMsgArr.forEach(item => {
                    const s = `[CQ:poke,qq=${item.data.qq}]`;
                    session.context.lastReply = s;
                    seal.replyToSender(ctx, msg, s);
                });
            }

            if (messageArray.length === 0) return '';

            const uid = ctx.player!.userId;
            if (msg.messageType === 'private') {
                const result = await callOb11ApiForContext(ctx, msg, "send_private_msg", { user_id: uid.replace(/^.+:/, ""), message: messageArray });
                if (result.ok && result.message_id) {
                    sendLog.debug(`(${result.message_id})发送给${uid}:${s}`);
                    return transformMsgId(result.message_id);
                }
            } else if (msg.messageType === 'group') {
                const gid = ctx.group ? ctx.group.groupId : '';
                const result = await callOb11ApiForContext(ctx, msg, "send_group_msg", { group_id: gid.replace(/^.+:/, ""), message: messageArray });
                if (result.ok && result.message_id) {
                    sendLog.debug(`(${result.message_id})发送给${gid}:${s}`);
                    return transformMsgId(result.message_id);
                }
            }
            sendLog.warning('无法获取 message_id');
        } catch (error) {
            // OB11 发送链路（含参数构造/上下文取值）任何异常都不允许吞掉回复：落回海豹 API 发送
            sendLog.exception('OB11 发送异常，落回海豹 API 发送', error);
        }
    }
    session.context.lastReply = s;
    seal.replyToSender(ctx, msg, s);
    return '';
}

