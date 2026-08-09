// 消息管线：接收 → 过滤（忽略/触发）→ 会话 → 智能体，统一处理非指令/指令/机器人自身消息
import { BlockManager } from "./block";
import Config, { ext } from "./config/config";
import { CQ_TYPES_ALLOW } from "./config/static_config";
import { logger } from "./logger";
import { getSession } from "./session/session_service";
import Tool from "./tool/tool";
import { triggerConditionMap } from "./tool/tools/tool_trigger";
import { expandForwardMessage } from "./utils/ob11";
import { createCtx, createMsg } from "./utils/seal";
import { MessageSegment, parseCardToText, parseMusicToText, transformTextToArray } from "./utils/string";

/** 海豹核心原生 milky 接收路径会过滤掉的段类型，只能通过 ob11 依赖的事件分发（milky → OB11 转接）收到 */
const OB11_EXTRA_SEGMENT_TYPES = new Set(['json', 'video', 'file', 'node', 'forward', 'music', 'xml', 'markdown', 'market_face']);

export class MessagePipeline {
    /** ob11 数组消息段 → MessageSegment[]：把卡片/视频/音乐/文件/消息节点/合并转发展开为文本段，其余段保留 */
    private static async expandOb11Segments(ctx: seal.MsgContext, segs: any[]): Promise<MessageSegment[]> {
        const result: MessageSegment[] = [];
        const epId = ctx.endPoint.userId;
        for (const seg of segs) {
            if (!seg || typeof seg !== 'object') continue;
            const data = seg.data || {};
            switch (seg.type) {
                case 'json': {
                    result.push({ type: 'text', data: { text: parseCardToText(data.data) } });
                    break;
                }
                case 'file': {
                    // milky 转接与 NapCat 的 file 段字段略有差异（file/name/file_id），统一取可用值
                    result.push({ type: 'text', data: { text: `【文件】${data.name || data.file || data.file_id || ''}` } });
                    break;
                }
                case 'video': {
                    result.push({ type: 'text', data: { text: `【视频】${data.file || ''}` } });
                    break;
                }
                case 'music': {
                    result.push({ type: 'text', data: { text: parseMusicToText(data) } });
                    break;
                }
                case 'node': {
                    result.push({ type: 'text', data: { text: await MessagePipeline.parseNodeToText(ctx, data) } });
                    break;
                }
                case 'forward': {
                    const text = await expandForwardMessage(epId, data.id || data.file || '');
                    result.push({
                        type: 'text',
                        data: { text: text ? `【合并转发】\n${text}` : '[合并转发消息，展开失败]' }
                    });
                    break;
                }
                default: result.push(seg as MessageSegment);
            }
        }
        return result;
    }

    /** 消息节点（node）转可读文本：完整节点递归内容，仅 id 时走 ob11 获取 */
    private static async parseNodeToText(ctx: seal.MsgContext, data: any): Promise<string> {
        const name = (data && (data.nickname || data.name)) || (data && data.user_id ? `用户${data.user_id}` : '');
        if (data && typeof data.content === 'string') {
            return `${name}: ${data.content}`;
        }
        if (data && Array.isArray(data.content)) {
            const segs = await this.expandOb11Segments(ctx, data.content);
            let text = '';
            for (const s of segs) {
                text += s.type === 'text' ? ((s.data && s.data.text) || '') : `[${s.type}]`;
            }
            return `${name}: ${text}`;
        }
        if (data && data.id) {
            const text = await expandForwardMessage(ctx.endPoint.userId, String(data.id));
            return text ? `${name}:\n${text}` : `【消息节点】${name}`;
        }
        return `【消息节点】${name}`;
    }

    /** 订阅 ob11 网络连接依赖的事件分发：核心原生 milky 路径会丢弃视频/文件/卡片/合并转发等段，
     *  这些段只有依赖的 OneBot 事件流（milky → OB11 转接）能拿到，在此接入并走同一套非指令管线 */
    static subscribeOb11Receive(): void {
        const net = (globalThis as any).net;
        if (!net || typeof net.getEventDispatcher !== 'function') return;
        net.getEventDispatcher(ext).then((ed: any) => {
            ed.onMessageEvent = async (_epId: string, event: any) => {
                try {
                    await MessagePipeline.handleOb11Event(event);
                } catch (e) {
                    logger.error(`ob11 事件消息处理出错:${e instanceof Error ? e.message : String(e)}`);
                }
            };
        }).catch((e: any) => {
            logger.error(`订阅 ob11 事件分发失败:${e instanceof Error ? e.message : String(e)}`);
        });
    }

    /** ob11 事件消息（OneBot 消息段数组）：仅处理核心原生路径收不到的段类型，避免与核心回调重复处理 */
    private static async handleOb11Event(event: any): Promise<void> {
        if (!event || event.post_type !== 'message') return;
        const message = event.message;
        if (!Array.isArray(message)) return;
        if (event.user_id === event.self_id) return; // 机器人自己的消息（核心原生路径会忽略，这里保持一致）
        if (!message.some((seg: any) => seg && OB11_EXTRA_SEGMENT_TYPES.has(seg.type))) return;

        // 按端点解析平台前缀（默认 QQ），并构造与核心回调一致的 ctx/msg
        const eps = seal.getEndPoints();
        let epId = `QQ:${event.self_id}`;
        for (const ep of eps) {
            if (ep.userId === epId) break;
            if (ep.userId.endsWith(`:${event.self_id}`)) epId = ep.userId;
        }
        const prefix = epId.includes(':') ? epId.slice(0, epId.indexOf(':')) : 'QQ';
        const uid = `${prefix}:${event.user_id}`;
        const isPrivate = event.message_type !== 'group';
        const gid = isPrivate ? '' : `${prefix}-Group:${event.group_id}`;

        const msg = createMsg(isPrivate ? 'private' : 'group', uid, gid);
        msg.platform = prefix;
        msg.message = message as any; // 消息段数组，交给 expandOb11Segments 展开
        msg.time = event.time || 0;
        msg.rawId = event.message_id ?? 0;
        msg.sender.nickname = (event.sender && (event.sender.card || event.sender.nickname)) || '';
        msg.sender.userId = uid;

        const ctx = createCtx(epId, msg);
        if (!ctx) {
            logger.warning(`ob11 事件消息未找到通信端点: ${epId}，跳过`);
            return;
        }
        await MessagePipeline.handleNonCommand(ctx, msg);
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
        // ob11 网络连接依赖以 OneBot 消息段数组传入时，走独立解析（卡片/视频/音乐/文件/消息节点/合并转发）；
        // 海豹原生 CQ 码字符串路径保持不变
        const messageArray = Array.isArray(message)
            ? await this.expandOb11Segments(ctx, message)
            : transformTextToArray(message);
        // 正则匹配统一使用可读文本：原生路径保持原字符串，数组路径用展开后的文本
        const messageText = Array.isArray(message)
            ? messageArray.map(item => item.type === 'text' ? ((item.data && item.data.text) || '') : `[${item.type}]`).join('')
            : message;

        // 忽略条件（豹语表达式）命中时直接忽略
        if (parseInt(seal.format(ctx, `{${IGNORE_CONDITION}}`)) === 1) {
            logger.info('忽略消息条件命中，跳过');
            return;
        }

        if (ignoreRegex.test(messageText)) {
            logger.info(`非指令消息忽略:${messageText}`);
            return;
        }

        // 检查CQ码
        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            if (session.context.timer) clearTimeout(session.context.timer);
            session.context.timer = null;

            // 非指令消息触发（受会话开关控制）
            if (session.setting.regexTrigger && triggerRegex.test(messageText)) {
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
                            keywordMatched = new RegExp(condition.keyword).test(messageText);
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
    static handleCommand(ctx: seal.MsgContext, msg: seal.Message, cmdArgs: seal.CmdArgs): void {
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
        const messageArray = transformTextToArray(message);

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            const setting = session.setting;
            if (setting.standby) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
            }
        }
    }

    /** 机器人自身发送的消息：转发给监听工具，并按配置决定是否记录上下文 */
    static handleBotMessage(ctx: seal.MsgContext, msg: seal.Message): void {
        const uid = ctx.player!.userId;
        const gid = ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        session.checkActiveTimer(ctx);

        const message = msg.message;
        const messageArray = transformTextToArray(message);

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
