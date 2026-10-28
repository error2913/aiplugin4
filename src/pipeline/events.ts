// 事件分发（叶子）：ob11 通知/请求事件与原生通知事件 → 事件提示词入库（白名单 → 待机 → 去重 → 录入上下文），
// 并在录制成功后按「事件触发规则」决定是否触发 AI（忙时由 pendingQueue 挂起，轮末由既有 resumePending 续跑）。
// 从 pipeline.ts 拆出——事件处理只依赖 notice 工具、黑名单、会话与去重表，与消息触发/命令管线解耦；
// pipeline.ts 保留同名静态方法委派（MessagePipeline.handleOb11*Event 外部调用零改动）。
import { BlockManager } from "../block";
import Config from "../config/config";
import { buildEventDedupKeyFor, buildNativeNoticeText, buildNoticeText, buildRequestText, isDuplicateEvent, isNoticeInWhitelist, isSelfCoveredNoticeEvent, parseNoticeWhitelist } from "../event/notice";
import { eventTypeOfNotice, eventTypeOfRequest } from "../event/trigger";
import type { EventView } from "../event/trigger";
import { logger } from "../logger";
import { getSession } from "../session/session_service";
import { normalizeMsgId } from "../utils/message_id";
import { SYSTEM_NAME } from "../utils/protocol";
import { getPlatform } from "../utils/target_id";

import { getEventEntryRef, rememberEventEntryRef } from "./dedup";
import { resolveEndpointId } from "./endpoint";
import { maybeTriggerEvent } from "./event_trigger";

const log = logger.withTag('pipeline');

/** 事件触发视图基础字段（各来源补充自己的类型字段） */
function baseView(epId: string, prefix: string, sid: string, isPrivate: boolean, text: string): EventView {
    return {
        source: 'notice',
        postType: 'notice',
        eventType: '',
        noticeType: '',
        requestType: '',
        subType: '',
        userId: '',
        operatorId: '',
        groupId: '',
        messageId: '',
        targetId: '',
        isTargetBot: false,
        epId,
        platform: prefix,
        botId: epId,
        sid,
        isPrivate,
        eventText: text,
        flag: '',
        comment: '',
        receivedAt: Date.now(),
    };
}

    /** ob11 依赖通知事件（OneBot notice）→ 文本提示词录入上下文：仅白名单内类型，仅作背景不触发 AI */
export async function handleOb11NoticeEvent(event: any): Promise<void> {
        if (!event || event.post_type !== 'notice' || !event.notice_type) return;

        const noticeType = String(event.notice_type);
        const subType = String(event.sub_type || '');
        // 机器人自身入群/被移出/退群由原生回调（onGroupJoined/onGroupLeave）覆盖，
        // 依赖侧跳过，否则同一物理事件会在两路径以不同 eventType/文本各录一次。
        if (isSelfCoveredNoticeEvent(noticeType, event.user_id, event.self_id)) {
            log.debug(`ob11 通知事件为机器人自身 ${noticeType}，由原生回调覆盖，跳过`);
            return;
        }

        // notify/poke：部分适配器的核心原生 onPoke 不下发，这里直接用 ob11 事件触发；
        // 不走「事件接收」白名单（白名单只决定背景录入），并与原生 onPoke 路径共用同一个触发去重 key，
        // 保证两路径只触发一次（原生路径仍会把 poke 作为消息入库）。
        if (noticeType === 'notify' && subType === 'poke') {
            const pokeEpId = resolveEndpointId(event.self_id);
            if (!pokeEpId) {
                log.debug(`ob11 poke 事件未找到匹配端点 self_id=${event.self_id}，跳过`);
                return;
            }
            const prefix = getPlatform(pokeEpId);
            const isGroup = !!event.group_id;
            const pokeUserRaw = event.user_id ?? event.operator_id;
            let sid = '';
            if (isGroup) {
                sid = `${prefix}-Group:${event.group_id}`;
            } else {
                const uid = pokeUserRaw ?? event.target_id;
                if (!uid) {
                    log.debug('ob11 poke 事件缺少 user_id/target_id，跳过');
                    return;
                }
                sid = `${prefix}:${uid}`;
            }
            const userId = pokeUserRaw ? `${prefix}:${pokeUserRaw}` : '';
            const targetId = event.target_id !== undefined && event.target_id !== null && String(event.target_id) !== ''
                ? `${prefix}:${event.target_id}`
                : '';
            const eventText = isGroup
                ? `Group event: ${userId || 'someone'} poked ${targetId || 'someone'}.`
                : `Private event: ${userId || 'someone'} poked you.`;
            const view: EventView = {
                ...baseView(pokeEpId, prefix, sid, !isGroup, eventText),
                source: 'poke',
                postType: 'poke',
                eventType: 'poke',
                noticeType,
                subType,
                userId,
                groupId: isGroup ? `${prefix}-Group:${event.group_id}` : '',
                targetId,
                isTargetBot: !!targetId && targetId === pokeEpId,
                raw: event,
            };
            // 与 pipeline.ts 原生 onPoke 路径共用 key：两路径只触发一次
            const dedupKey = `poke|${pokeEpId}|${sid}|${userId}|${targetId}`;
            await maybeTriggerEvent(view, dedupKey, { injectEventText: true });
            return;
        }

        const { RECEIVE_NOTICE, NOTICE_TYPES } = Config.event;
        if (!RECEIVE_NOTICE) return;

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
        // 与原生撤回路径共用同一 messageId 归一（十进制转 base36），保证双路径去重 key 一致
        const messageId = normalizeMsgId(event.message_id);
        const eventType = eventTypeOfNotice(noticeType, subType);
        const dedupKey = buildEventDedupKeyFor(epId, sid, eventType, userId, messageId, event);
        const view: EventView = {
            ...baseView(epId, prefix, sid, !isGroup, text),
            eventType,
            noticeType,
            subType,
            userId,
            operatorId: event.operator_id ? `${prefix}:${event.operator_id}` : '',
            groupId: isGroup ? `${prefix}-Group:${event.group_id}` : '',
            messageId,
            raw: event,
        };
        const recorded = await recordEventPrompt({
            sid,
            text,
            systemName: SYSTEM_NAME.groupEvent,
            epId,
            eventType: noticeType,
            userId,
            messageId,
            dedupKey,
            raw: event,
        });
        if (recorded) await maybeTriggerEvent(view, dedupKey);
    }

    /** ob11 依赖请求事件（OneBot request）→ 文本提示词：白名单含对应类型时录入，仅作背景不触发 AI */
export async function handleOb11RequestEvent(event: any): Promise<void> {
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
        const eventType = eventTypeOfRequest(requestType);
        const dedupKey = buildEventDedupKeyFor(epId, sid, eventType, userId, '', event);
        const view: EventView = {
            ...baseView(epId, prefix, sid, requestType === 'friend', text),
            source: 'request',
            postType: 'request',
            eventType,
            requestType,
            subType: String(event.sub_type || ''),
            userId,
            operatorId: event.operator_id ? `${prefix}:${event.operator_id}` : '',
            groupId: event.group_id ? `${prefix}-Group:${event.group_id}` : '',
            flag: String(event.flag ?? ''),
            comment: String(event.comment ?? ''),
            raw: event,
        };
        const recorded = await recordEventPrompt({
            sid,
            text,
            systemName: SYSTEM_NAME.requestEvent,
            epId,
            eventType,
            userId,
            messageId: '',
            dedupKey,
            raw: event,
        });
        if (recorded) await maybeTriggerEvent(view, dedupKey);
    }

    /** 原生海豹回调事件（成员加入/退出/撤回/加好友/入驻）：白名单含对应类型时录入，与 ob11 依赖双路径共用去重 */
export async function handleNativeNoticeEvent(epId: string, sid: string, info: { noticeType: string; subType?: string; userId?: string; operatorId?: string; messageId?: string }): Promise<void> {
        const { RECEIVE_NOTICE, NOTICE_TYPES } = Config.event;
        if (!RECEIVE_NOTICE) return;
        const whitelist = parseNoticeWhitelist(NOTICE_TYPES);
        if (!whitelist.has(info.noticeType)) return;
        const text = buildNativeNoticeText(info);
        if (!text) return;
        const eventType = info.noticeType;
        const userId = info.userId || '';
        const messageId = info.messageId || '';
        const dedupKey = buildEventDedupKeyFor(epId, sid, eventType, userId, messageId, info);
        const isPrivate = !sid.includes('-Group:');
        const prefix = getPlatform(epId);
        const view: EventView = {
            ...baseView(epId, prefix, sid, isPrivate, text),
            eventType,
            noticeType: info.noticeType,
            subType: info.subType || '',
            userId,
            operatorId: info.operatorId || '',
            groupId: isPrivate ? '' : sid,
            messageId,
            raw: info,
        };
        const recorded = await recordEventPrompt({
            sid,
            text,
            systemName: SYSTEM_NAME.groupEvent,
            epId,
            eventType,
            userId,
            messageId,
            dedupKey,
            raw: info,
        });
        if (recorded) await maybeTriggerEvent(view, dedupKey);
    }

    /** 事件提示词统一入库：黑名单 → 待机 → 去重 → 纯代码兜底 → 录入上下文（仅背景，不触发 AI） */
async function recordEventPrompt(opts: {
        sid: string;
        text: string;
        systemName: string;
        epId: string;
        eventType: string;
        userId: string;
        messageId?: string;
        /** 去重 key（调用方按同一口径预先算好，录制与触发共用） */
        dedupKey: string;
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
        // 事件提示词不再走压缩智能体：文本由纯代码按模板从事件 JSON 生成，通常很短；
        // 此处仅做纯代码兜底（超 2000 字 head 截断），完整原始数据仍挂在条目 raw 上，可用 read_raw kind=event 查看
        const text = opts.text.length > 2000 ? opts.text.slice(0, 2000) : opts.text;
        const entryExtra = { eventType: opts.eventType, raw: opts.raw };
        if (isDuplicateEvent(opts.dedupKey)) {
            // 去重命中（echo / 双路径 / 指纹无法区分的兜底情况）：不丢弃后到副本，
            // 以"最后到达的事件"作为唯一事件——就地替换先前已入库的旧副本（保留原位置与顺序）。
            const ref = getEventEntryRef(opts.dedupKey);
            let replaced = false;
            if (ref) {
                replaced = session.context.replaceSystemUserMessage(ref, text, opts.systemName, entryExtra);
            }
            if (!replaced) {
                // 旧条目已被合并压缩/归档改写或引用丢失：改为追加新副本兜底，避免事件内容彻底丢失
                log.debug(`事件去重命中但旧条目不可替换，追加新副本：${opts.eventType} @ ${opts.sid}`);
                const newRef = session.context.addSystemUserMessageTracked(text, opts.systemName, entryExtra);
                if (newRef) rememberEventEntryRef(opts.dedupKey, newRef);
            }
            session.save(true);   // 合并写：事件是高频入库路径
            log.debug(`事件去重合并（保留最后到达）：${opts.eventType} @ ${opts.sid} text=${text.slice(0, 60)}`);
            return true;
        }
        const entryRef = session.context.addSystemUserMessageTracked(text, opts.systemName, entryExtra);
        if (entryRef) rememberEventEntryRef(opts.dedupKey, entryRef);
        session.save(true);   // 合并写：事件是高频入库路径
        log.debug(`事件已录入上下文：${opts.eventType} @ ${opts.sid} text=${text.slice(0, 60)}`);
        return true;
    }
