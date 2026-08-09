// 消息管线：接收 → 过滤（忽略/触发）→ 会话 → 智能体，统一处理非指令/指令/机器人自身消息
import { BlockManager } from "./block";
import Config from "./config/config";
import { CQ_TYPES_ALLOW } from "./config/static_config";
import { logger } from "./logger";
import { getSession } from "./session/session_service";
import Tool from "./tool/tool";
import { triggerConditionMap } from "./tool/tools/tool_trigger";
import { expandForwardMessage } from "./utils/ob11";
import { MessageSegment, transformTextToArray } from "./utils/string";

export class MessagePipeline {
    /** 展开消息中的合并转发段（走 ob11 get_forward_msg，支持嵌套），返回替换后的消息段 */
    private static async expandForwardSegments(epId: string, segs: MessageSegment[]): Promise<MessageSegment[]> {
        const result: MessageSegment[] = [];
        for (const seg of segs) {
            if (seg.type === 'forward') {
                const text = await expandForwardMessage(epId, (seg.data && seg.data.id) || '');
                result.push({
                    type: 'text',
                    data: { text: text ? `【合并转发】\n${text}` : '[合并转发消息，展开失败]' }
                });
            } else {
                result.push(seg);
            }
        }
        return result;
    }

    /** 非指令消息：过滤后进入会话，由智能体决定是否触发回复 */
    static async handleNonCommand(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const { IGNORE_PRIVATE: disabledInPrivate, IGNORE_REGEX: ignoreRegex, IGNORE_CONDITION } = Config.received;
        const { TRIGGER_REGEX: triggerRegex, TRIGGER_CONDITION: triggerCondition } = Config.trigger;

        // 黑名单用户/群的消息不接收不处理
        const uid = ctx.player!.userId;
        const blockReason = BlockManager.checkBlock(uid);
        if (blockReason) {
            logger.info(`用户<${uid}>在黑名单中，原因: ${blockReason}，忽略消息`);
            return;
        }
        if (!ctx.isPrivate) {
            const gid = ctx.group!.groupId;
            const groupBlockReason = BlockManager.checkBlock(gid);
            if (groupBlockReason) {
                logger.info(`群组<${gid}>在黑名单中，原因: ${groupBlockReason}，忽略消息`);
                return;
            }
        }

        if (ctx.isPrivate && disabledInPrivate) {
            return;
        }

        const gid = ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        // 检查活跃时间定时器
        session.checkActiveTimer(ctx);

        const message = msg.message;
        let messageArray = transformTextToArray(message);

        // 展开合并转发（走 ob11 get_forward_msg），替换为可读文本段后再走后续过滤/触发
        if (messageArray.some(seg => seg.type === 'forward')) {
            messageArray = await this.expandForwardSegments(ctx.endPoint.userId, messageArray);
        }

        // 忽略条件（豹语表达式）命中时直接忽略
        if (parseInt(seal.format(ctx, `{${IGNORE_CONDITION}}`)) === 1) {
            logger.info('忽略消息条件命中，跳过');
            return;
        }

        if (ignoreRegex.test(message)) {
            logger.info(`非指令消息忽略:${message}`);
            return;
        }

        // 检查CQ码
        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            if (session.context.timer) clearTimeout(session.context.timer);
            session.context.timer = null;

            // 非指令消息触发（受会话开关控制）
            if (session.setting.regexTrigger && triggerRegex.test(message)) {
                const fmtCondition = parseInt(seal.format(ctx, `{${triggerCondition}}`));
                if (fmtCondition === 1) {
                    return session.handleReceipt(ctx, msg, messageArray)
                        .then(() => session.chat(ctx, msg, '非指令'));
                }
            }

            // AI自己设定的触发条件触发
            if (Object.prototype.hasOwnProperty.call(triggerConditionMap, sid) && triggerConditionMap[sid].length !== 0) {
                for (let i = 0; i < triggerConditionMap[sid].length; i++) {
                    const condition = triggerConditionMap[sid][i];
                    // 关键词正则非法时跳过该条件，避免解析异常中断整条消息处理
                    let keywordMatched = true;
                    if (condition.keyword) {
                        try {
                            keywordMatched = new RegExp(condition.keyword).test(message);
                        } catch (e) {
                            logger.error(`触发关键词正则错误，已忽略该条件:${condition.keyword}，错误信息:${e instanceof Error ? e.message : String(e)}`);
                            keywordMatched = false;
                        }
                    }
                    if (!keywordMatched) {
                        continue;
                    }
                    if (condition.uid && condition.uid !== uid) {
                        continue;
                    }

                    return session.handleReceipt(ctx, msg, messageArray)
                        .then(() => session.context.addSystemUserMessage(condition.reason, '触发原因提示'))
                        .then(() => triggerConditionMap[sid].splice(i, 1))
                        .then(() => session.chat(ctx, msg, 'AI设定触发条件'));
                }
            }

            // 开启任一模式时
            const setting = session.setting;
            if (setting.standby || Config.base.GLOBAL_STANDBY) {
                session.handleReceipt(ctx, msg, messageArray)
                    .then((): void | Promise<void> => {
                        if (setting.counter > -1) {
                            session.context.counter += 1;
                            if (session.context.counter >= setting.counter) {
                                session.context.counter = 0;
                                return session.chat(ctx, msg, '计数器');
                            }
                        }

                        if (setting.prob > -1) {
                            const ran = Math.random() * 100;
                            if (ran <= setting.prob) {
                                return session.chat(ctx, msg, '概率');
                            }
                        }

                        if (setting.timer > -1) {
                            session.context.timer = setTimeout(() => {
                                session.context.timer = null;
                                session.chat(ctx, msg, '计时器');
                            }, setting.timer * 1000 + Math.floor(Math.random() * 500));
                        }
                    })
                    .then(() => session.save());
            }
        }
    }

    /** 指令消息：记录 cmdArgs，并按配置决定是否写入会话上下文 */
    static async handleCommand(ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs): Promise<void> {
        if (Tool.cmdArgs === null) {
            Tool.cmdArgs = cmdArgs;
        }

        const { RECEIVE_CMD: allcmd } = Config.received;
        if (!allcmd) return;

        const uid = ctx.player!.userId;
        const gid = ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        session.checkActiveTimer(ctx);

        const message = msg.message;
        let messageArray = transformTextToArray(message);

        // 展开合并转发（走 ob11 get_forward_msg），替换为可读文本段
        if (messageArray.some(seg => seg.type === 'forward')) {
            messageArray = await this.expandForwardSegments(ctx.endPoint.userId, messageArray);
        }

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            const setting = session.setting;
            if (setting.standby) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
            }
        }
    }

    /** 机器人自身发送的消息：转发给监听工具，并按配置决定是否记录上下文 */
    static async handleBotMessage(ctx: seal.MsgContext, msg: seal.Message): Promise<void> {
        const uid = ctx.player!.userId;
        const gid = ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        session.checkActiveTimer(ctx);

        const message = msg.message;
        let messageArray = transformTextToArray(message);

        // 展开合并转发（走 ob11 get_forward_msg），替换为可读文本段
        if (messageArray.some(seg => seg.type === 'forward')) {
            messageArray = await this.expandForwardSegments(ctx.endPoint.userId, messageArray);
        }

        session.tool.listen.resolve?.(message); // 将消息传递给监听工具

        const { RECEIVE_MSG_BY_BOT: allmsg } = Config.received;
        if (!allmsg) return;

        if (message === session.context.lastReply) {
            session.context.lastReply = '';
            return;
        }

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            const setting = session.setting;
            if (setting.standby) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
            }
        }
    }
}
