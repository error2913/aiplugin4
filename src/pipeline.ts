// 消息管线：接收 → 过滤（忽略/触发）→ 会话 → 智能体，统一处理非指令/指令/机器人自身消息
import { BlockManager } from "./block";
import Config, { ext } from "./config/config";
import { CQ_TYPES_ALLOW } from "./config/static_config";
import { Context } from "./context/context";
import { buildEventDedupKey, buildNativeNoticeText, buildNoticeText, buildRequestText, isDuplicateEvent, isNoticeInWhitelist, parseNoticeWhitelist } from "./event/notice";
import { JudgeManager } from "./judge/judge_manager";
import { logger } from "./logger";
import { getSession } from "./session/session_service";
import { dispatchLocalCommandOutput } from "./tool/local_command_capture";
import { triggerConditionMap } from "./tool/tools/core/tool_trigger";
import { expandForwardMessage } from "./utils/ob11";
import { createCtx, createMsg } from "./utils/seal";
import { registerSpecialResource } from "./utils/special_id";
import { expandMilkySegments, formatMediaSegmentText, formatMessageSegmentsForMatching, MessageSegment, parseCardToText, parseMusicToText, transformTextToArray, truncateText } from "./utils/string";
import { getPlatform } from "./utils/target_id";
import { getRecordMessageId, transformMsgId } from "./utils/utils";

const log = logger.withTag('pipeline');

/** 按机器人自身 ID 反查匹配的通信端点；匹配不到返回空串（调用方跳过）。
 *  双连接冗余下同一 QQ 可能有直连与桥两个端点：优先返回已连接（state=1）的端点，
 *  全部不在线时回退到第一个匹配端点。 */
export function resolveEndpointId(selfId: string | number): string {
    const suffix = `:${selfId}`;
    const eps = seal.getEndPoints();
    let fallback = '';
    for (const ep of eps) {
        if (!ep.userId.endsWith(suffix)) continue;
        if (ep.state === 1) return ep.userId;
        if (!fallback) fallback = ep.userId;
    }
    return fallback;
}


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
                    // QQ 卡片消息：转为上下文专用闭合标签 [card]...[/card]，AI 可读标题/描述/链接
                    result.push({ type: 'text', data: { text: parseCardToText(data.data), __system: '1' } });
                    break;
                }
                case 'record': {
                    // milky 适配器会丢弃语音段，这里由 ob11 转接事件补收：登记句柄并渲染 [record:句柄]摘要[/record]，
                    // AI 可通过 resolve_special_id(type=record, id=句柄) 获取原始文件字段。
                    const recordHandle = registerSpecialResource('record', data);
                    result.push({ type: 'text', data: { text: formatMediaSegmentText('语音', data, recordHandle), __system: '1' } });
                    break;
                }
                case 'file': {
                    // 登记句柄并渲染 [file:句柄]文件名[/file]，AI 可通过 resolve_special_id(type=file, id=句柄) 查询或下载
                    const fileHandle = registerSpecialResource('file', data);
                    result.push({ type: 'text', data: { text: formatMediaSegmentText('文件', data, fileHandle), __system: '1' } });
                    break;
                }
                case 'video': {
                    // 登记句柄并渲染 [video:句柄]摘要[/video]，AI 可通过 resolve_special_id(type=video, id=句柄) 查询
                    const videoHandle = registerSpecialResource('video', data);
                    result.push({ type: 'text', data: { text: formatMediaSegmentText('视频', data, videoHandle), __system: '1' } });
                    break;
                }
                case 'music': {
                    result.push({ type: 'text', data: { text: parseMusicToText(data), __system: '1' } });
                    break;
                }
                case 'market_face': {
                    // 商城表情/超级表情：milky 转接只透传元数据，转为 [face]表情名[/face] 占位避免段静默丢失
                    result.push({ type: 'text', data: { text: `[face]${data.summary ? String(data.summary) : '未知商城表情'}[/face]`, __system: '1' } });
                    break;
                }
                case 'xml': {
                    // XML 卡片/公众号消息：转为 [xml]...[/xml]，过长时截断避免污染上下文
                    result.push({ type: 'text', data: { text: `[xml]${data.data ? truncateText(String(data.data), 500) : '未知XML消息'}[/xml]`, __system: '1' } });
                    break;
                }
                case 'markdown': {
                    // Markdown 消息：milky 转接成 OB11 markdown 段，转为 [markdown]...[/markdown] 进入上下文
                    result.push({ type: 'text', data: { text: `[markdown]${data.content ? truncateText(String(data.content), 500) : '未知Markdown'}[/markdown]`, __system: '1' } });
                    break;
                }
                case 'node': {
                    const nodeText = await MessagePipeline.parseNodeToText(ctx, data, depth + 1);
                    result.push({ type: 'text', data: { text: `[node]${nodeText}[/node]`, __system: '1' } });
                    break;
                }
                case 'forward': {
                    const text = await expandForwardMessage(epId, data.id || data.file || '', depth + 1);
                    result.push({
                        type: 'text',
                        data: { text: text ? `[forward]\n${text}\n[/forward]` : '[forward]合并转发展开失败[/forward]', __system: '1' }
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
            return `${name}（嵌套过深，已截断）`;
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
            return text ? `${name}:\n${text}` : `${name}`;
        }
        return name || '未知消息节点';
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
            log.debug(`ob11 事件消息为字符串（${String(message).slice(0, 50)}），由核心原生路径处理，跳过`);
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
        await MessagePipeline.handleNonCommand(ctx, msg, message, { source: 'dependency' });
    }

    /** ob11 依赖通知事件（OneBot notice）→ 文本提示词录入上下文：仅白名单内类型，仅作背景不触发 AI */
    static async handleOb11NoticeEvent(event: any): Promise<void> {
        if (!event || event.post_type !== 'notice' || !event.notice_type) return;
        const { RECEIVE_NOTICE, NOTICE_TYPES } = Config.event;
        if (!RECEIVE_NOTICE) return;

        const noticeType = String(event.notice_type);
        const subType = String(event.sub_type || '');
        const whitelist = parseNoticeWhitelist(NOTICE_TYPES);
        if (!isNoticeInWhitelist(noticeType, subType, whitelist)) {
            log.debug(`ob11 通知事件不在白名单，跳过: type=${noticeType} sub=${subType}`);
            return;
        }

        const epId = resolveEndpointId(event.self_id);
        if (!epId) {
            log.debug(`ob11 事件未找到匹配端点 self_id=${event.self_id}，跳过`);
            return;
        }
        const prefix = getPlatform(epId);

        const isGroup = !!(event.group_id || noticeType.startsWith('group_'));
        let sid = '';
        if (isGroup) {
            if (!event.group_id) {
                log.debug(`ob11 通知事件（群事件）缺少 group_id，跳过: type=${noticeType}`);
                return;
            }
            sid = `${prefix}-Group:${event.group_id}`;
        } else {
            const uid = event.user_id ?? event.operator_id;
            if (!uid) {
                log.debug(`ob11 通知事件（好友事件）缺少 user_id/operator_id，跳过: type=${noticeType}`);
                return;
            }
            sid = `${prefix}:${uid}`;
        }

        const text = buildNoticeText(event, prefix);
        if (!text) {
            log.debug(`ob11 通知事件无可读文本，跳过: type=${noticeType} sub=${subType}`);
            return;
        }

        const eventUserId = event.user_id ?? event.operator_id;
        const userId = eventUserId ? `${prefix}:${eventUserId}` : '';
        const messageId = event.message_id !== undefined && event.message_id !== null ? String(event.message_id) : '';
        await MessagePipeline.recordEventPrompt({
            sid,
            text,
            systemName: '群事件提示',
            epId,
            eventType: noticeType,
            userId,
            messageId,
            raw: event,
        });
    }

    /** ob11 依赖请求事件（OneBot request）→ 文本提示词：白名单含对应类型时录入，仅作背景不触发 AI */
    static async handleOb11RequestEvent(event: any): Promise<void> {
        if (!event || event.post_type !== 'request' || !event.request_type) return;
        const { RECEIVE_NOTICE, NOTICE_TYPES } = Config.event;
        if (!RECEIVE_NOTICE) return;

        const requestType = String(event.request_type);
        const whitelist = parseNoticeWhitelist(NOTICE_TYPES);
        if (!whitelist.has(requestType + '_request')) {
            log.debug(`ob11 请求事件不在白名单，跳过: type=${requestType}_request`);
            return;
        }

        const epId = resolveEndpointId(event.self_id);
        if (!epId) {
            log.debug(`ob11 事件未找到匹配端点 self_id=${event.self_id}，跳过`);
            return;
        }
        const prefix = getPlatform(epId);

        // 严格会话归属：入群申请 → 群会话；好友申请 → 私聊会话；映射不到即丢弃
        let sid = '';
        if (requestType === 'group') {
            if (!event.group_id) {
                log.debug(`ob11 请求事件（入群申请）缺少 group_id，跳过`);
                return;
            }
            sid = `${prefix}-Group:${event.group_id}`;
        } else if (requestType === 'friend') {
            if (!event.user_id) {
                log.debug(`ob11 请求事件（好友申请）缺少 user_id，跳过`);
                return;
            }
            sid = `${prefix}:${event.user_id}`;
        } else {
            return;
        }

        const text = buildRequestText(event, prefix);
        if (!text) return;

        const userId = event.user_id ? `${prefix}:${event.user_id}` : '';
        await MessagePipeline.recordEventPrompt({
            sid,
            text,
            systemName: '请求事件提示',
            epId,
            eventType: `${requestType}_request`,
            userId,
            messageId: '',
            raw: event,
        });
    }

    /** 原生海豹回调事件（成员加入/退出/撤回/加好友/入驻）：白名单含对应类型时录入，与 ob11 依赖双路径共用去重 */
    static async handleNativeNoticeEvent(epId: string, sid: string, info: { noticeType: string; subType?: string; userId?: string; operatorId?: string; messageId?: string }): Promise<void> {
        const { RECEIVE_NOTICE, NOTICE_TYPES } = Config.event;
        if (!RECEIVE_NOTICE) return;
        const whitelist = parseNoticeWhitelist(NOTICE_TYPES);
        if (!whitelist.has(info.noticeType)) return;
        const text = buildNativeNoticeText(info);
        if (!text) return;
        await MessagePipeline.recordEventPrompt({
            sid,
            text,
            systemName: '群事件提示',
            epId,
            eventType: info.noticeType,
            userId: info.userId || '',
            messageId: info.messageId || '',
            raw: info,
        });
    }

    /** 事件提示词统一入库：黑名单 → 待机 → 去重 → 压缩 → 录入上下文（仅背景，不触发 AI） */
    private static async recordEventPrompt(opts: {
        sid: string;
        text: string;
        systemName: string;
        epId: string;
        eventType: string;
        userId: string;
        messageId?: string;
        raw?: unknown;
    }): Promise<boolean> {
        const blockReason = BlockManager.checkBlock(opts.sid);
        if (blockReason) {
            log.debug(`事件忽略：会话<${opts.sid}>在黑名单（${blockReason}）`);
            return false;
        }
        if (opts.userId) {
            const userBlockReason = BlockManager.checkBlock(opts.userId);
            if (userBlockReason) {
                log.debug(`事件忽略：用户<${opts.userId}>在黑名单（${userBlockReason}）`);
                return false;
            }
        }
        // 待机关口：事件仅在待机（会话待机或全局待机）时录入上下文，与普通消息入库口径一致
        const session = getSession(opts.sid);
        if (!(session.setting.standby || Config.base.GLOBAL_STANDBY)) {
            log.debug(`事件忽略：会话<${opts.sid}>未开启待机，不录入事件`);
            return false;
        }
        if (isDuplicateEvent(buildEventDedupKey(opts.epId, opts.sid, opts.eventType, opts.userId, opts.messageId || ''))) {
            log.debug(`事件去重丢弃：${opts.eventType} @ ${opts.sid}`);
            return false;
        }
        // 事件文本过长时交给压缩智能体（复用全局「消息压缩阈值」，默认 2000），失败保留原文
        const text = await Context.compressIfLong(opts.text);
        session.context.addSystemUserMessage(text, opts.systemName, {
            eventType: opts.eventType,
            raw: opts.raw,
        });
        session.save();
        log.debug(`事件已录入上下文：${opts.eventType} @ ${opts.sid} text=${text.slice(0, 60)}`);
        return true;
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
            log.debug(`milky 消息段展开: ${messageText.slice(0, 200)}`);
        }

        const isCoreMessage = options?.source !== 'dependency' && !options?.supplementOnly;
        const coreMessageKey = isCoreMessage ? rememberCoreMessage(ctx, msg, messageArray) : '';

        // 依赖补充只入库，不重新执行正则、计数器、概率、计时器或 AI 触发。
        if (options?.supplementOnly) {
            if (messageArray.length === 0) return;
            const supplementTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
            if (supplementTypes.some(type => !CQ_TYPES_ALLOW.includes(type))) return;
            if (sessionBusy) {
                return session.deferReceipt(ctx, msg, messageArray, 'record').then(() => session.savePending());
            }
            return session.handleReceipt(ctx, msg, messageArray).then(() => session.save());
        }

        // 忽略条件（豹语表达式）命中时直接忽略
        if (parseInt(seal.format(ctx, `{${IGNORE_CONDITION}}`)) === 1) {
            if (coreMessageKey) coreMessageStates.delete(coreMessageKey);
            log.info('忽略消息条件命中，跳过');
            return;
        }

        if (ignoreRegex.test(messageText)) {
            if (coreMessageKey) coreMessageStates.delete(coreMessageKey);
            log.info(`非指令消息忽略:${messageText}`);
            return;
        }

        // 检查CQ码
        const CQTypes = messageArray.filter(item => item.type !== 'text').map(item => item.type);
        if (CQTypes.length === 0 || CQTypes.every(item => CQ_TYPES_ALLOW.includes(item))) {
            // 运行中不重置待触发计时器（待机计数/概率/计时器一律跳过，只入库不推进）
            if (!sessionBusy && session.context.timer) clearTimeout(session.context.timer);
            if (!sessionBusy) session.context.timer = null;

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
                        .then(() => session.context.addSystemUserMessage(condition.reason, '触发原因提示'))
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
            if (setting.standby) {
                session.handleReceipt(ctx, msg, messageArray).then(() => session.save()).catch((e: any) => {
                    log.exception('机器人消息入库出错', e);
                });
            }
        }
    }
}
