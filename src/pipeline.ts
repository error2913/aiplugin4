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

/** 解析 QQ 卡片消息（CQ:json 的 data 字段），提取标题/描述/链接等可读文本 */
function parseCardToText(raw: string): string {
    if (!raw) return '[卡片消息]';

    let obj: any = null;
    try {
        obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_e) {
        return `[卡片消息] ${raw.slice(0, 200)}`;
    }

    const str = (v: any): string => (typeof v === 'string' && v.trim()) ? v.trim() : '';

    // 常见卡片结构：view / meta.news / meta.detail 等
    const view = (obj && (obj.view || (obj.meta && (obj.meta.news || obj.meta.detail || obj.meta.article)))) || obj || {};
    const title = str(view.title) || str(obj.desc) || str(view.desc) || '';
    const desc = str(view.desc) || str(view.summary) || (view.news && str(view.news.desc)) || '';
    const url = str(view.url) || str(view.jumpUrl) || (view.news && str(view.news.jumpUrl)) || (view.detail && str(view.detail.jumpUrl)) || '';

    const parts = [title, desc].filter(Boolean);
    if (parts.length === 0) return '[卡片消息]';
    return `【卡片】${parts.join('\n')}${url ? `\n${url}` : ''}`;
}

/** 音乐段转可读文本（data 为 qq/163 id 或 custom 对象） */
function parseMusicToText(data: any): string {
    if (data && data.title) return `【音乐】${data.title}`;
    const type = data && data.type ? String(data.type) : '';
    const id = data && data.id ? String(data.id) : '';
    return `【音乐】${type}${id ? ` ${id}` : ''}`;
}

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
                    result.push({ type: 'text', data: { text: `【文件】${data.file || ''}` } });
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
