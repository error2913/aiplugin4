// 消息管线：接收 → 过滤（忽略/触发）→ 会话 → 智能体，统一处理非指令/指令/机器人自身消息
import { BlockManager } from "./block";
import Config, { ext } from "./config/config";
import { CQ_TYPES_ALLOW } from "./config/static_config";
import { logger } from "./logger";
import { getSession } from "./session/session_service";
import { triggerConditionMap } from "./tool/tools/core/tool_trigger";
import { expandForwardMessage } from "./utils/ob11";
import { createCtx, createMsg } from "./utils/seal";
import { expandMilkySegments, formatFileSegmentText, formatMessageSegmentsForMatching, MessageSegment, parseCardToText, parseMusicToText, transformTextToArray, truncateText } from "./utils/string";
import { getRecordMessageId, transformMsgId } from "./utils/utils";

/** 核心原生 milky 路径通常过滤掉的段，只由 ob11 依赖补充。 */
const OB11_SUPPLEMENT_SEGMENT_TYPES = new Set(['record', 'json', 'video', 'file', 'node', 'forward', 'music', 'xml', 'markdown', 'market_face']);
const CORE_MESSAGE_TTL_MS = 2000;
const DEPENDENCY_WAIT_MS = 100;

interface CoreMessageState {
    expiresAt: number;
    recorded: boolean;
    types: Set<string>;
}

const coreMessageStates = new Map<string, CoreMessageState>();

function pruneCoreMessageStates(now: number = Date.now()): void {
    coreMessageStates.forEach((state, key) => {
        if (state.expiresAt <= now) coreMessageStates.delete(key);
    });
}

function getMessageKey(ctx: seal.MsgContext, msg: seal.Message): string {
    const sessionId = ctx.isPrivate ? ctx.player?.userId || '' : ctx.group?.groupId || '';
    const messageId = getRecordMessageId(ctx, msg) || transformMsgId(msg.rawId);
    return `${ctx.endPoint.userId}|${sessionId}|${messageId}`;
}

function rememberCoreMessage(ctx: seal.MsgContext, msg: seal.Message, messageArray: MessageSegment[]): string {
    const key = getMessageKey(ctx, msg);
    pruneCoreMessageStates();
    coreMessageStates.set(key, {
        expiresAt: Date.now() + CORE_MESSAGE_TTL_MS,
        recorded: false,
        types: new Set(messageArray
            .filter(item => item.type !== 'text')
            .map(item => item.type === 'at' && item.data && item.data.qq === 'all' ? 'at:all' : item.type))
    });
    return key;
}

function markCoreMessageRecorded(key: string): void {
    const state = coreMessageStates.get(key);
    if (state) state.recorded = true;
}

function getCoreMessageState(key: string): CoreMessageState | undefined {
    pruneCoreMessageStates();
    return coreMessageStates.get(key);
}

/** 依赖事件只筛选核心缺失段；face 由核心是否已收到动态决定。 */
export function filterOb11SupplementSegments(message: any[], coreTypes?: Set<string>): any[] {
    return message.filter((seg: any) => {
        if (!seg || typeof seg !== 'object' || !seg.type) return false;
        if (OB11_SUPPLEMENT_SEGMENT_TYPES.has(seg.type)) return true;
        if (seg.type === 'at' && seg.data && seg.data.qq === 'all') return !coreTypes?.has('at:all');
        return seg.type === 'face' && !coreTypes?.has('face');
    });
}

function waitForCoreEvent(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, DEPENDENCY_WAIT_MS));
}

/** 消息节点/合并转发展开的最大嵌套深度，防止恶意或异常嵌套导致无限递归 */
const MAX_FORWARD_DEPTH = 5;

/**
 * 判断某个 OB11 消息段是否属于“核心原生 milky 适配器收不到、只能靠 ob11 依赖补收”的段。
 * mention_all 会被 ob11 依赖转成 at(qq=all)，而原生 milky 适配器只处理 mention，会丢弃 mention_all。
 */
function isOb11ExtraSegment(seg: any): boolean {
    return filterOb11SupplementSegments([seg]).length > 0;
}

export class MessagePipeline {
    /** ob11 数组消息段 → MessageSegment[]：把卡片/视频/音乐/文件/消息节点/合并转发展开为文本段，其余段保留 */
    private static async expandOb11Segments(ctx: seal.MsgContext, segs: any[], depth: number = 0): Promise<MessageSegment[]> {
        if (depth > MAX_FORWARD_DEPTH) {
            return [{ type: 'text', data: { text: '[消息嵌套过深，已截断]' } }];
        }
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
                case 'record': {
                    // milky 适配器会丢弃语音段，这里由 ob11 转接事件补收并转成可读文本
                    result.push({ type: 'text', data: { text: '【语音】' } });
                    break;
                }
                case 'file': {
                    // 保留文件名之外的 path/url/file_id 等字段，供 AI 继续调用文件工具读取或导入。
                    result.push({ type: 'text', data: { text: formatFileSegmentText(data) } });
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
                case 'market_face': {
                    // 商城表情/超级表情：milky 转接只透传 emoji 元数据，这里转为可读占位，避免段静默丢失
                    result.push({ type: 'text', data: { text: data.summary ? `【表情】${data.summary}` : '【表情】' } });
                    break;
                }
                case 'xml': {
                    // XML 卡片/公众号消息：保留关键内容，过长时截断避免污染上下文
                    result.push({ type: 'text', data: { text: data.data ? `【XML消息】${truncateText(String(data.data), 500)}` : '【XML消息】' } });
                    break;
                }
                case 'markdown': {
                    // Markdown 消息：milky 转接成 OB11 markdown 段，转成文本进入上下文
                    result.push({ type: 'text', data: { text: data.content ? `【Markdown】${truncateText(String(data.content), 500)}` : '【Markdown】' } });
                    break;
                }
                case 'node': {
                    result.push({ type: 'text', data: { text: await MessagePipeline.parseNodeToText(ctx, data, depth + 1) } });
                    break;
                }
                case 'forward': {
                    const text = await expandForwardMessage(epId, data.id || data.file || '', depth + 1);
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
    private static async parseNodeToText(ctx: seal.MsgContext, data: any, depth: number = 0): Promise<string> {
        const name = (data && (data.nickname || data.name)) || (data && data.user_id ? `用户${data.user_id}` : '');
        if (depth > MAX_FORWARD_DEPTH) {
            return `【消息节点】${name}（嵌套过深，已截断）`;
        }
        if (data && typeof data.content === 'string') {
            return `${name}: ${data.content}`;
        }
        if (data && Array.isArray(data.content)) {
            const segs = await this.expandOb11Segments(ctx, data.content, depth + 1);
            let text = '';
            for (const s of segs) {
                text += s.type === 'text' ? ((s.data && s.data.text) || '') : `[${s.type}]`;
            }
            return `${name}: ${text}`;
        }
        if (data && data.id) {
            const text = await expandForwardMessage(ctx.endPoint.userId, String(data.id), depth + 1);
            return text ? `${name}:\n${text}` : `【消息节点】${name}`;
        }
        return `【消息节点】${name}`;
    }

    /** 订阅 ob11 网络连接依赖的事件分发：核心原生 milky 路径会丢弃视频/文件/卡片/合并转发等段，
     *  这些段只有依赖的 OneBot 事件流（milky → OB11 转接）能拿到，在此接入并走同一套非指令管线 */
    static subscribeOb11Receive(): void {
        const trySubscribe = (attempt: number): void => {
            const net = (globalThis as any).net;
            if (!net || typeof net.getEventDispatcher !== 'function') {
                if (attempt < 20) {
                    // ob11 依赖可能在 aiplugin4 之后加载，轮询等待就绪
                    setTimeout(() => trySubscribe(attempt + 1), 5000);
                } else {
                    logger.info('[debug] 等待 ob11 网络连接依赖就绪超时（20 次×5s），跳过 ob11 额外消息接收订阅');
                }
                return;
            }
            net.getEventDispatcher(ext).then((ed: any) => {
                ed.onMessageEvent = async (_epId: string, event: any) => {
                    try {
                        await MessagePipeline.handleOb11Event(event);
                    } catch (e) {
                        logger.error(`ob11 事件消息处理出错:${e instanceof Error ? e.message : String(e)}`);
                    }
                };
                logger.info('[debug] 已订阅 ob11 事件分发，额外接收卡片/视频/音乐/文件/语音/合并转发等消息段');
            }).catch((e: any) => {
                logger.error(`订阅 ob11 事件分发失败:${e instanceof Error ? e.message : String(e)}`);
            });
        };
        trySubscribe(0);
    }

    /** ob11 事件消息（OneBot 消息段数组）：核心优先，依赖只补充核心未收到的段 */
    private static async handleOb11Event(event: any): Promise<void> {
        if (!event || event.post_type !== 'message') return;
        const message = event.message;
        if (!Array.isArray(message)) {
            logger.debug(`ob11 事件消息为字符串（${String(message).slice(0, 50)}），由核心原生路径处理，跳过`);
            return;
        }
        if (event.user_id === event.self_id) {
            logger.debug(`ob11 事件消息来自机器人自身（${event.user_id}），跳过`);
            return;
        }
        const segTypes = message.filter((seg: any) => seg && seg.type).map((seg: any) => seg.type);
        if (!message.some((seg: any) => isOb11ExtraSegment(seg))) {
            logger.debug(`ob11 事件消息无额外段（types=[${segTypes.join(',')}]），由核心原生路径处理，跳过`);
            return;
        }
        logger.info(`[debug] ob11 额外消息接收: ${event.message_type === 'group' ? '群' : '私聊'} uid=${event.user_id} segTypes=[${segTypes.join(',')}]`);

        // 按端点解析平台前缀（默认 QQ），并构造与核心回调一致的 ctx/msg
        const eps = seal.getEndPoints();
        let epId = `QQ:${event.self_id}`;
        for (const ep of eps) {
            if (ep.userId === epId) break;
            if (ep.userId.endsWith(`:${event.self_id}`)) epId = ep.userId;
        }
        logger.debug(`[debug] ob11 事件 端点解析完成 ep=${epId}`);
        const prefix = epId.includes(':') ? epId.slice(0, epId.indexOf(':')) : 'QQ';
        const uid = `${prefix}:${event.user_id}`;
        const isPrivate = event.message_type !== 'group';
        const gid = isPrivate ? '' : `${prefix}-Group:${event.group_id}`;

        const msg = createMsg(isPrivate ? 'private' : 'group', uid, gid);
        msg.platform = prefix;
        // seal.Message.message 是 string 绑定，数组塞进去会被强转成字符串，段数组改走参数传入
        msg.time = event.time || 0;
        msg.rawId = event.message_id ?? 0;
        msg.sender.nickname = (event.sender && (event.sender.card || event.sender.nickname)) || '';
        msg.sender.userId = uid;

        const ctx = createCtx(epId, msg);
        if (!ctx) {
            logger.warning(`ob11 事件消息未找到通信端点: ${epId}，跳过`);
            return;
        }
        logger.debug(`[debug] ob11 事件 ctx 构建完成 isPrivate=${ctx.isPrivate} player=${ctx.player && ctx.player.userId} group=${ctx.group && ctx.group.groupId}`);

        await waitForCoreEvent();
        const state = getCoreMessageState(getMessageKey(ctx, msg));
        if (state && !state.recorded) {
            logger.debug(`[debug] ob11 补充消息对应核心消息未入库，跳过依赖补充: id=${msg.rawId}`);
            return;
        }

        const supplementSegments = filterOb11SupplementSegments(message, state?.types);
        if (state) {
            if (supplementSegments.length === 0) {
                logger.debug(`[debug] ob11 补充消息无核心缺失段，跳过: id=${msg.rawId}`);
                return;
            }
            await MessagePipeline.handleNonCommand(ctx, msg, supplementSegments, { supplementOnly: true });
            return;
        }

        // 核心没有对应回调时，依赖事件作为完整消息兜底，不能只保留额外段。
        await MessagePipeline.handleNonCommand(ctx, msg, message, { source: 'dependency' });
    }

    /** 非指令消息：过滤后进入会话，由智能体决定是否触发回复 */
    static async handleNonCommand(ctx: seal.MsgContext, msg: seal.Message, ob11Segments?: any[], options?: { source?: 'core' | 'dependency'; supplementOnly?: boolean }): Promise<void> {
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

        const gid = ctx.isPrivate ? '' : ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        // 检查活跃时间定时器
        session.checkActiveTimer(ctx);

        const message = msg.message;
        // 核心消息优先：Milky 原生段 → 核心 OB11/CQ 字符串；依赖事件仅在显式传入时使用。
        const milkySegments = (msg as any).segment;
        const hasMilkySegments = Array.isArray(milkySegments) && milkySegments.length > 0;
        const messageArray = Array.isArray(ob11Segments)
            ? await this.expandOb11Segments(ctx, ob11Segments)
            : hasMilkySegments
            ? expandMilkySegments(ctx, milkySegments)
            : Array.isArray(message)
            ? await this.expandOb11Segments(ctx, message)
            : transformTextToArray(message);
        // 正则匹配统一使用可读文本：原生路径保持原字符串，数组路径用展开后的文本
        const messageText = Array.isArray(ob11Segments) || hasMilkySegments || Array.isArray(message)
            ? formatMessageSegmentsForMatching(messageArray, typeof message === 'string' ? message : '')
            : message;
        if (hasMilkySegments) {
            logger.debug(`[debug] milky 消息段展开: ${messageText.slice(0, 200)}`);
        }

        const isCoreMessage = options?.source !== 'dependency' && !options?.supplementOnly;
        const coreMessageKey = isCoreMessage ? rememberCoreMessage(ctx, msg, messageArray) : '';

        // 依赖补充只入库，不重新执行正则、计数器、概率、计时器或 AI 触发。
        if (options?.supplementOnly) {
            if (messageArray.length === 0) return;
            const supplementTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
            if (supplementTypes.some(type => !CQ_TYPES_ALLOW.includes(type))) return;
            return session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
        }

        // 忽略条件（豹语表达式）命中时直接忽略
        if (parseInt(seal.format(ctx, `{${IGNORE_CONDITION}}`)) === 1) {
            if (coreMessageKey) coreMessageStates.delete(coreMessageKey);
            logger.info('忽略消息条件命中，跳过');
            return;
        }

        if (ignoreRegex.test(messageText)) {
            if (coreMessageKey) coreMessageStates.delete(coreMessageKey);
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
                    markCoreMessageRecorded(coreMessageKey);
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

                    markCoreMessageRecorded(coreMessageKey);
                    return session.handleReceipt(ctx, msg, messageArray)
                        .then(() => session.context.addSystemUserMessage(condition.reason, '触发原因提示'))
                        .then(() => triggerConditionMap[sid].splice(i, 1))
                        .then(() => session.chat(ctx, msg, 'AI设定触发条件'));
                }
            }

            // 开启任一模式时
            const setting = session.setting;
            if (setting.standby || Config.base.GLOBAL_STANDBY) {
                markCoreMessageRecorded(coreMessageKey);
                return session.handleReceipt(ctx, msg, messageArray)
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
                                session.chat(ctx, msg, '计时器').catch((e: any) => {
                                    logger.error(`计时器触发对话出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
                                });
                            }, setting.timer * 1000 + Math.floor(Math.random() * 500));
                        }
                    })
                    .then(() => session.save());
            }
        }
    }

    /** 指令消息：按配置决定是否写入会话上下文 */
    static handleCommand(ctx: seal.MsgContext, msg: seal.Message): void {

        const { RECEIVE_CMD: allcmd } = Config.received;
        if (!allcmd) return;

        const uid = ctx.player!.userId;
        const gid = ctx.isPrivate ? '' : ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        session.checkActiveTimer(ctx);

        const message = msg.message;
        const milkySegments = (msg as any).segment;
        const hasMilkySegments = Array.isArray(milkySegments) && milkySegments.length > 0;
        const messageArray = hasMilkySegments ? expandMilkySegments(ctx, milkySegments) : transformTextToArray(message);

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            const setting = session.setting;
            if (setting.standby) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save()).catch((e: any) => {
                    logger.error(`指令消息入库出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
                });
            }
        }
    }

    /** 机器人自身发送的消息：转发给监听工具，并按配置决定是否记录上下文 */
    static handleBotMessage(ctx: seal.MsgContext, msg: seal.Message): void {
        const uid = ctx.player!.userId;
        const gid = ctx.isPrivate ? '' : ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);

        session.checkActiveTimer(ctx);

        const message = msg.message;
        const milkySegments = (msg as any).segment;
        const hasMilkySegments = Array.isArray(milkySegments) && milkySegments.length > 0;
        const messageArray = hasMilkySegments ? expandMilkySegments(ctx, milkySegments) : transformTextToArray(message);
        const messageText = hasMilkySegments
            ? messageArray.map(item => item.type === 'text' ? ((item.data && item.data.text) || '') : `[${item.type}]`).join('')
            : message;

        const deliver = session.tool.listen.push || session.tool.listen.resolve;
        deliver?.(messageText);

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
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save()).catch((e: any) => {
                    logger.error(`机器人消息入库出错，错误信息:${e instanceof Error ? e.message : String(e)}`);
                });
            }
        }
    }
}
