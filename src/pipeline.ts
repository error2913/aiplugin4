// 消息管线：接收 → 过滤（忽略/触发）→ 会话 → 智能体，统一处理非指令/指令/机器人自身消息
import { BlockManager } from "./block";
import Config, { ext } from "./config/config";
import { CQ_TYPES_ALLOW } from "./config/static_config";
import type { EventView } from "./event/trigger";
import { JudgeManager } from "./judge/judge_manager";
import { logger } from "./logger";
import { consumeDependencyTombstone, deleteCoreMessageState, filterOb11SupplementSegments, getCoreMessageState, getMessageKey, markCoreMessageRecorded, markDependencyFullRecorded, rememberCoreMessageByKey, waitForCoreEvent } from "./pipeline/dedup";
import { resolveEndpointId } from "./pipeline/endpoint";
import { hasEventTriggerRules, maybeTriggerEvent } from "./pipeline/event_trigger";
import { handleNativeNoticeEvent, handleOb11NoticeEvent, handleOb11RequestEvent } from "./pipeline/events";
import { expandOb11Segments } from "./pipeline/inbound";
import { getSession } from "./session/session_service";
import { dispatchLocalCommandOutput } from "./tool/local_command_capture";
import { triggerConditionMap } from "./tool/tools/core/tool_trigger";
import { getRecordMessageId, transformMsgId } from "./utils/message_id";
import { SYSTEM_NAME } from "./utils/protocol";
import { createCtx, createMsg } from "./utils/seal";
import { expandMilkySegments, formatMessageSegmentsForMatching, transformTextToArray } from "./utils/string";
import { getPlatform, normalizeUserId, platformOf } from "./utils/target_id";

const log = logger.withTag('pipeline');


// 兼容旧引用：ob11 补收段筛选已拆到 ./pipeline/dedup（内部实现请直接引用叶子）
export { filterOb11SupplementSegments } from "./pipeline/dedup";
export { resolveEndpointId } from "./pipeline/endpoint";




/**
 * 判断某个 OB11 消息段是否属于“核心原生 milky 适配器收不到、只能靠 ob11 依赖补收”的段。
 * mention_all 会被 ob11 依赖转成 at(qq=all)，而原生 milky 适配器只处理 mention，会丢弃 mention_all。
 */
function isOb11ExtraSegment(seg: any): boolean {
    return filterOb11SupplementSegments([seg]).length > 0;
}

export class MessagePipeline {

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
                    log.debug('等待 ob11 网络连接依赖就绪超时（20 次×5s），跳过 ob11 额外消息接收订阅');
                }
                return;
            }
            net.getEventDispatcher(ext).then((ed: any) => {
                ed.onMessageEvent = async (_epId: string, event: any) => {
                    try {
                        await MessagePipeline.handleOb11Event(event);
                    } catch (e) {
                        log.exception('ob11 事件消息处理出错', e);
                    }
                };
                ed.onNoticeEvent = async (_epId: string, event: any) => {
                    try {
                        await MessagePipeline.handleOb11NoticeEvent(event);
                    } catch (e) {
                        log.exception('ob11 通知事件处理出错', e);
                    }
                };
                ed.onRequestEvent = async (_epId: string, event: any) => {
                    try {
                        await MessagePipeline.handleOb11RequestEvent(event);
                    } catch (e) {
                        log.exception('ob11 请求事件处理出错', e);
                    }
                };
                log.debug('已订阅 ob11 事件分发：额外接收卡片/视频/音乐/文件/语音/合并转发等消息段，以及白名单通知/请求事件');
            }).catch((e: any) => {
                log.exception('订阅 ob11 事件分发失败', e);
            });
        };
        trySubscribe(0);
    }

    /** ob11 事件消息（OneBot 消息段数组）：核心优先，依赖只补充核心未收到的段 */
    private static async handleOb11Event(event: any): Promise<void> {
        if (!event || event.post_type !== 'message') return;
        const message = event.message;
        if (!Array.isArray(message)) {
            log.debug(`ob11 事件消息为字符串（${String(message)}），由核心原生路径处理，跳过`);
            return;
        }
        if (event.user_id === event.self_id) {
            log.debug(`ob11 事件消息来自机器人自身（${event.user_id}），跳过`);
            return;
        }
        const segTypes = message.filter((seg: any) => seg && seg.type).map((seg: any) => seg.type);
        if (!message.some((seg: any) => isOb11ExtraSegment(seg))) {
            log.debug(`ob11 事件消息无额外段（types=[${segTypes.join(',')}]），由核心原生路径处理，跳过`);
            return;
        }
        log.debug(`ob11 额外消息接收: ${event.message_type === 'group' ? '群' : '私聊'} uid=${event.user_id} segTypes=[${segTypes.join(',')}]`);

        // 按端点解析平台前缀，并构造与核心回调一致的 ctx/msg
        const epId = resolveEndpointId(event.self_id);
        if (!epId) {
            log.debug(`ob11 事件未找到匹配端点 self_id=${event.self_id}，跳过`);
            return;
        }
        log.debug(`ob11 事件 端点解析完成 ep=${epId}`);
        const prefix = getPlatform(epId);
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
            log.warning(`ob11 事件消息未找到通信端点: ${epId}，跳过`);
            return;
        }
        log.debug(`ob11 事件 ctx 构建完成 isPrivate=${ctx.isPrivate} player=${ctx.player && ctx.player.userId} group=${ctx.group && ctx.group.groupId}`);

        await waitForCoreEvent();
        const state = getCoreMessageState(getMessageKey(ctx, msg));
        if (state && state.depFull) {
            // 该消息此前已由依赖路径整条兜底（核心无对应回调），重复投递直接跳过，避免二次入库
            log.debug(`ob11 事件消息已被依赖路径整条处理，跳过重复投递: id=${msg.rawId}`);
            return;
        }
        if (state && !state.recorded) {
            log.debug(`ob11 补充消息对应核心消息未入库，跳过依赖补充: id=${msg.rawId}`);
            return;
        }

        const supplementSegments = filterOb11SupplementSegments(message, state?.types);
        if (state) {
            if (supplementSegments.length === 0) {
                log.debug(`ob11 补充消息无核心缺失段，跳过: id=${msg.rawId}`);
                return;
            }
            await MessagePipeline.handleNonCommand(ctx, msg, supplementSegments, { supplementOnly: true });
            return;
        }

        // 核心没有对应回调时，依赖事件作为完整消息兜底，不能只保留额外段。
        // 兜底开始前先打墓碑：若核心回调只是迟到（两条通路乱序/慢于等待窗），核心侧会消费墓碑
        // 并放弃本次处理，避免同一条消息双录、甚至双触发 AI。兜底本身失败时再撤掉墓碑，
        // 把处理交还给可能迟到的核心回调，避免消息彻底丢失。
        const fallbackKey = getMessageKey(ctx, msg);
        markDependencyFullRecorded(fallbackKey);
        try {
            await MessagePipeline.handleNonCommand(ctx, msg, message, { source: 'dependency' });
        } catch (e) {
            consumeDependencyTombstone(fallbackKey);
            throw e;
        }
    }

    static async handleOb11NoticeEvent(event: any): Promise<void> {
        await handleOb11NoticeEvent(event);
    }

    static async handleOb11RequestEvent(event: any): Promise<void> {
        await handleOb11RequestEvent(event);
    }

    static async handleNativeNoticeEvent(epId: string, sid: string, info: { noticeType: string; subType?: string; userId?: string; operatorId?: string; messageId?: string }): Promise<void> {
        await handleNativeNoticeEvent(epId, sid, info);
    }

    /** 非指令消息：过滤后进入会话，由智能体决定是否触发回复 */
    static async handleNonCommand(ctx: seal.MsgContext, msg: seal.Message, ob11Segments?: any[], options?: { source?: 'core' | 'dependency'; supplementOnly?: boolean }): Promise<void> {
        const { IGNORE_PRIVATE: disabledInPrivate, IGNORE_REGEX: ignoreRegex, IGNORE_CONDITION } = Config.received;
        const { TRIGGER_REGEX: triggerRegex, TRIGGER_CONDITION: triggerCondition } = Config.trigger;

        // 黑名单用户/群的消息不接收不处理
        const uid = ctx.player!.userId;
        const blockReason = BlockManager.checkBlock(uid);
        if (blockReason) {
            log.info(`用户<${uid}>在黑名单中，原因: ${blockReason}，忽略消息`);
            return;
        }
        if (!ctx.isPrivate) {
            const gid = ctx.group!.groupId;
            const groupBlockReason = BlockManager.checkBlock(gid);
            if (groupBlockReason) {
                log.info(`群组<${gid}>在黑名单中，原因: ${groupBlockReason}，忽略消息`);
                return;
            }
        }

        if (ctx.isPrivate && disabledInPrivate) {
            return;
        }

        const gid = ctx.isPrivate ? '' : ctx.group!.groupId;
        const sid = ctx.isPrivate ? uid : gid;
        const session = getSession(sid);
        // 会话忙（正在运行或正在启动）时，新消息不直接入库/触发，改为挂起由 run 循环统一处理
        const sessionBusy = session.running || session.starting;

        // 检查活跃时间定时器
        session.checkActiveTimer(ctx);

        const message = msg.message;
        // 核心消息优先：Milky 原生段 → 核心 OB11/CQ 字符串；依赖事件仅在显式传入时使用。
        const milkySegments = (msg as any).segment;
        const hasMilkySegments = Array.isArray(milkySegments) && milkySegments.length > 0;
        const messageArray = Array.isArray(ob11Segments)
            ? await expandOb11Segments(ctx, ob11Segments)
            : hasMilkySegments
            ? expandMilkySegments(ctx, milkySegments)
            : Array.isArray(message)
            ? await expandOb11Segments(ctx, message)
            : transformTextToArray(message);
        // 正则匹配统一使用可读文本：原生路径保持原字符串，数组路径用展开后的文本
        const messageText = Array.isArray(ob11Segments) || hasMilkySegments || Array.isArray(message)
            ? formatMessageSegmentsForMatching(messageArray, typeof message === 'string' ? message : '')
            : message;
        if (hasMilkySegments) {
            log.debug(`milky 消息段展开: ${messageText}`);
        }

        const isCoreMessage = options?.source !== 'dependency' && !options?.supplementOnly;
        let coreMessageKey = '';
        if (isCoreMessage) {
            const key = getMessageKey(ctx, msg);
            // 依赖路径已整条兜底处理过该消息（核心回调迟到）：直接放弃，避免双录/双触发
            if (consumeDependencyTombstone(key)) {
                log.debug(`依赖路径已整条处理过该消息，核心迟到放弃，避免双录: id=${getRecordMessageId(ctx, msg) || transformMsgId(msg.rawId)}`);
                return;
            }
            rememberCoreMessageByKey(key, messageArray);
            coreMessageKey = key;
        }

        // 依赖补充只入库，不重新执行正则、计数器、概率、计时器或 AI 触发。
        if (options?.supplementOnly) {
            if (messageArray.length === 0) return;
            const supplementTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
            if (supplementTypes.some(type => !CQ_TYPES_ALLOW.includes(type))) return;
            if (sessionBusy) {
                return session.deferReceipt(ctx, msg, messageArray, 'record').then(() => session.savePending());
            }
            return session.handleReceipt(ctx, msg, messageArray).then(() => session.save(true));
        }

        // 忽略条件（豹语表达式）命中时直接忽略
        if (parseInt(seal.format(ctx, `{${IGNORE_CONDITION}}`)) === 1) {
            if (coreMessageKey) deleteCoreMessageState(coreMessageKey);
            log.info('忽略消息条件命中，跳过');
            return;
        }

        if (ignoreRegex.test(messageText)) {
            if (coreMessageKey) deleteCoreMessageState(coreMessageKey);
            log.info(`非指令消息忽略:${messageText}`);
            return;
        }

        // 检查CQ码
        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            // 运行中不重置待触发计时器（待机计数/概率/计时器一律跳过，只入库不推进）
            if (!sessionBusy && session.context.timer) clearTimeout(session.context.timer);
            if (!sessionBusy) session.context.timer = null;

            // poke 事件触发：poke 已被转换为内容部分（[CQ:poke] → poke 段 → [poke:ID]），
            // 先按消息口径入库，再按「事件触发规则」决定是否起轮；命中即跳过后续普通触发，避免双回复。
            if (hasEventTriggerRules() && (session.setting.standby || Config.base.GLOBAL_STANDBY)) {
                const pokeSeg = messageArray.find(item => item.type === 'poke');
                if (pokeSeg) {
                    const targetRaw = String((pokeSeg.data && (pokeSeg.data.qq || pokeSeg.data.user_id)) || '');
                    const targetId = normalizeUserId(targetRaw, platformOf(ctx)) || '';
                    const eventText = ctx.isPrivate
                        ? `Private event: ${uid} poked you.`
                        : `Group event: ${uid} poked ${targetId || targetRaw}.`;
                    const view: EventView = {
                        source: 'poke',
                        postType: 'poke',
                        eventType: 'notify.poke',
                        noticeType: 'notify',
                        requestType: '',
                        subType: 'poke',
                        userId: uid,
                        operatorId: '',
                        groupId: gid,
                        messageId: '',
                        targetId,
                        isTargetBot: !!targetId && targetId === ctx.endPoint.userId,
                        epId: ctx.endPoint.userId,
                        platform: getPlatform(ctx.endPoint.userId),
                        botId: ctx.endPoint.userId,
                        sid,
                        isPrivate: ctx.isPrivate,
                        eventText,
                        flag: '',
                        comment: '',
                        raw: { notice_type: 'notify', sub_type: 'poke', user_id: uid, target_id: targetId || targetRaw },
                        receivedAt: Date.now(),
                    };
                    // 与 ob11 notice poke 路径共用 key：两路径只触发一次
                    const dedupKey = `poke|${ctx.endPoint.userId}|${sid}|${uid}|${targetId || targetRaw}`;
                    if (await maybeTriggerEvent(view, dedupKey, { session, ctx, msg, messageArray })) {
                        markCoreMessageRecorded(coreMessageKey);
                        return;
                    }
                }
            }

            // 非指令消息触发（受会话开关控制）
            if (session.setting.regexTrigger && triggerRegex.test(messageText)) {
                const fmtCondition = parseInt(seal.format(ctx, `{${triggerCondition}}`));
                if (fmtCondition === 1) {
                    markCoreMessageRecorded(coreMessageKey);
                    if (sessionBusy) {
                        return session.deferReceipt(ctx, msg, messageArray, 'trigger').then(() => session.savePending());
                    }
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
                            log.exception('触发关键词正则错误，已忽略该条件: ' + condition.keyword, e);
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
                    if (sessionBusy) {
                        // 先消费一次性触发条件再挂起，避免条件残留导致下次重复触发
                        triggerConditionMap[sid].splice(i, 1);
                        return session.deferReceipt(ctx, msg, messageArray, 'trigger', condition.reason).then(() => session.savePending());
                    }
                    return session.handleReceipt(ctx, msg, messageArray)
                        .then(() => session.context.addSystemUserMessage(condition.reason, SYSTEM_NAME.trigger))
                        .then(() => triggerConditionMap[sid].splice(i, 1))
                        .then(() => session.chat(ctx, msg, 'AI设定触发条件'));
                }
            }

            // 开启任一模式时
            const setting = session.setting;
            if (setting.standby || Config.base.GLOBAL_STANDBY) {
                markCoreMessageRecorded(coreMessageKey);
                if (sessionBusy) {
                    // 运行中待机消息只挂起入库：计数/概率/计时器一律跳过，不推进、不触发
                    return session.deferReceipt(ctx, msg, messageArray, 'record').then(() => session.savePending());
                }
                return session.handleReceipt(ctx, msg, messageArray)
                    .then(async (): Promise<void> => {
                        if (setting.counter > -1) {
                            session.context.counter += 1;
                            if (session.context.counter >= setting.counter) {
                                session.context.counter = 0;
                                await session.chat(ctx, msg, '计数器');
                                return;
                            }
                        }

                        if (setting.prob > -1) {
                            const ran = Math.random() * 100;
                            if (ran <= setting.prob) {
                                await session.chat(ctx, msg, '概率');
                                return;
                            }
                        }

                        if (setting.timer > -1) {
                            session.context.timer = setTimeout(() => {
                                session.context.timer = null;
                                session.chat(ctx, msg, '计时器').catch((e: any) => {
                                    log.exception('计时器触发对话出错', e);
                                });
                            }, setting.timer * 1000 + Math.floor(Math.random() * 500));
                        }

                        if (setting.judge) {
                            await JudgeManager.evaluate(ctx, msg, session, messageText);
                        }
                    })
                    .then(() => session.save(true));   // 合并写：待机群每条消息都会走到这里
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
            // 待机判定必须同时看全局待机（B3）：只判 setting.standby 会让"全局待机"下指令消息不入库，
            // 与会话待机行为不一致（其余入库点如 handleGroupMessage 已是 `standby || GLOBAL_STANDBY`）。
            if (setting.standby || Config.base.GLOBAL_STANDBY) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save(true)).catch((e: any) => {
                    log.exception('指令消息入库出错', e);
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

        const captured = dispatchLocalCommandOutput(sid, messageText);
        if (!captured) {
            const deliver = session.tool.listen.push || session.tool.listen.resolve;
            deliver?.(messageText);
        }

        const { RECEIVE_MSG_BY_BOT: allmsg } = Config.received;
        if (!allmsg) return;

        if (message === session.context.lastReply) {
            session.context.lastReply = '';
            return;
        }

        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            const setting = session.setting;
            // 同上（B3）：全局待机下机器人自身消息也应入库
            if (setting.standby || Config.base.GLOBAL_STANDBY) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save(true)).catch((e: any) => {
                    log.exception('机器人消息入库出错', e);
                });
            }
        }
    }
}
