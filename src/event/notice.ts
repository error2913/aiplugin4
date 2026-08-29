import { truncateText } from "../utils/string";
// 上下文内保留事件原始数据的条目上限（超出从最旧删除 raw，文本提示词保留）
export const EVENT_RAW_LIMIT = 20;
/** 单条事件原始数据序列化后的最大长度，超过则丢弃 raw（防御性上限，正常事件远小于此） */
export const EVENT_RAW_MAX_CHARS = 4000;

/** 事件原始数据是否可安全保留：可 JSON 序列化且不超过长度上限 */
export function isEventRawRetainable(raw: unknown): boolean {
    if (raw === undefined || raw === null) return false;
    try {
        const s = JSON.stringify(raw);
        return !!s && s.length <= EVENT_RAW_MAX_CHARS;
    } catch {
        return false;
    }
}

// 依赖事件 → 文本提示词：纯函数转换 + 去重守卫（ob11 依赖 notice/request 事件）

/** 事件级去重窗口：同 key 事件在此窗口内只记录一次（原生回调与 ob11 依赖双路径防双录） */
const EVENT_DEDUP_WINDOW_MS = 3000;
const eventDedupMap = new Map<string, number>();

/** 重置去重状态（单元测试用） */
export function resetEventGuards(): void {
    eventDedupMap.clear();
}

/** 事件级去重：窗口内已存在同 key 返回 true（重复，应丢弃）；否则记录并返回 false */
export function isDuplicateEvent(key: string, now: number = Date.now()): boolean {
    eventDedupMap.forEach((expiresAt, k) => {
        if (expiresAt <= now) eventDedupMap.delete(k);
    });
    if (eventDedupMap.has(key)) return true;
    eventDedupMap.set(key, now + EVENT_DEDUP_WINDOW_MS);
    return false;
}

/** 通知事件白名单解析：去空白/去空行/小写，兼容换行与逗号分隔 */
export function parseNoticeWhitelist(list: string[]): Set<string> {
    const set = new Set<string>();
    for (const raw of list || []) {
        for (const item of String(raw).split(/[,，\n]/)) {
            const t = item.trim().toLowerCase();
            if (t) set.add(t);
        }
    }
    return set;
}

/** 事件去重 key：epId + 会话 + 事件类型 + 用户 + 消息ID（撤回用）。窗口内同 key 视为同一事件双路径到达 */
export function buildEventDedupKey(epId: string, sessionId: string, eventType: string, userId: string, messageId: string = ''): string {
    return `${epId}|${sessionId}|${eventType}|${userId}|${messageId}`;
}

function uniUserId(id: any, prefix: string): string {
    return id === undefined || id === null || id === '' ? '' : `${prefix}:${id}`;
}

function uniGroupId(id: any, prefix: string): string {
    return id === undefined || id === null || id === '' ? '' : `${prefix}-Group:${id}`;
}

function formatFileSize(bytes: any): string {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * OB11 通知事件 → 自描述文本提示词（ID 统一转 UNI-ID：<平台>:xxx / <平台>-Group:xxx）。
 * 白名单外/无法识别的类型返回空字符串（由调用方跳过）。
 */
export function buildNoticeText(event: any, prefix: string): string {
    const noticeType = event.notice_type || '';
    const subType = event.sub_type || '';
    const user = uniUserId(event.user_id, prefix);
    const operator = uniUserId(event.operator_id, prefix);
    switch (noticeType) {
        case 'group_ban': {
            const target = user || '未知成员';
            if (subType === 'lift_ban') return `【群事件】${operator || '管理员'} 解除了 ${target} 的禁言`;
            return `【群事件】${operator || '管理员'} 将 ${target} 禁言 ${event.duration ?? '?'} 秒`;
        }
        case 'group_admin': {
            const target = user || '未知成员';
            return subType === 'unset' ? `【群事件】${target} 被取消管理员` : `【群事件】${target} 被设为管理员`;
        }
        case 'group_upload': {
            const file = event.file || {};
            const size = formatFileSize(file.size);
            return `【群事件】${user || '群成员'} 上传了文件「${file.name || file.file || '未知文件'}」${size ? `（${size}）` : ''}`;
        }
        case 'notify': {
            if (subType === 'lucky_king') return `【群事件】${user || '群成员'} 抢到了运气王红包`;
            if (subType === 'honor') return `【群事件】${user || '群成员'} 获得群荣誉「${event.honor_type || '未知荣誉'}」`;
            if (subType === 'poke') return ''; // poke 由原生 onPoke 处理，不在这里录
            return `【群事件】${user || '群成员'} 触发通知（${subType}）`;
        }
        case 'group_increase':
            return `【群事件】${user || '成员'} 加入本群${operator ? `（由 ${operator} ${subType === 'invite' ? '邀请' : '通过'}）` : ''}`;
        case 'group_decrease': {
            if (subType === 'kick_me') return `【群事件】本机器人被移出群聊`;
            if (subType === 'kick') return `【群事件】${operator || '管理员'} 将 ${user || '成员'} 移出本群`;
            return `【群事件】${user || '成员'} 退出本群`;
        }
        case 'group_recall':
            return `【群事件】${operator || user || '成员'} 撤回了一条消息`;
        case 'friend_recall':
            return `【好友事件】${user || '好友'} 撤回了一条消息`;
        case 'friend_add':
            return `【好友事件】已与 ${user || '新好友'} 成为好友`;
        case 'group_name_change':
            return `【群事件】群名称变更为「${event.group_name || event.name || '未知'}」`;
        case 'group_disband':
            return `【群事件】本群已解散`;
        case 'group_whole_mute': {
            const off = subType === 'off' || event.enable === false || event.enable === 0 || Number(event.duration) === 0;
            return off ? `【群事件】全员禁言已关闭` : `【群事件】全员禁言已开启`;
        }
        case 'friend_file_upload':
            return `【好友事件】${user || '好友'} 发送了文件「${event.file?.name || event.file_name || '未知文件'}」`;
        case 'peer_pin_change':
            return `【会话事件】${user || '成员'} ${event.pinned === false ? '取消置顶' : '置顶'}了一条消息`;
        case 'group_message_reaction':
            return `【群事件】${user || '成员'} 对消息${event.reaction ? `添加表情「${event.reaction}」` : '做出反应'}`;
        case 'group_essence_message_change':
            return `【群事件】${user || '成员'} 的消息被${event.is_set === false ? '取消' : '设为'}精华`;
        default:
            return '';
    }
}

/** OB11 请求事件 → 文本提示词（好友/入群申请）；无法识别返回空字符串 */
export function buildRequestText(event: any, prefix: string): string {
    const requestType = event.request_type || '';
    const user = uniUserId(event.user_id, prefix);
    const group = uniGroupId(event.group_id, prefix);
    const comment = event.comment ? `：${truncateText(String(event.comment), 80)}` : '';
    const hint = '（完整事件数据可调用 get_event_detail 查看，处理申请需要）';
    if (requestType === 'friend') {
        return `【好友请求】${user || '未知用户'} 请求添加好友${comment}${hint}`;
    }
    if (requestType === 'group') {
        const action = event.sub_type === 'invite' ? '邀请加入' : '申请加入';
        return `【入群请求】${user || '未知用户'} ${action}${group ? '群 ' + group : ''}${comment}${hint}`;
    }
    return '';
}

/** 原生海豹回调路径：直接按 UNI-ID 生成事件提示词（与 OB11 事件文本同风格；重叠类型仅白名单含时才启用） */
export function buildNativeNoticeText(info: { noticeType: string; subType?: string; userId?: string; operatorId?: string }): string {
    const { noticeType, subType = '', userId = '', operatorId = '' } = info;
    switch (noticeType) {
        case 'group_joined':
            return `【群事件】本机器人加入本群`;
        case 'group_increase':
            return `【群事件】${userId || '成员'} 加入本群`;
        case 'group_decrease':
            if (subType === 'kick_me') return `【群事件】本机器人被移出群聊`;
            if (subType === 'kick') return `【群事件】${operatorId || '管理员'} 将 ${userId || '成员'} 移出本群`;
            return `【群事件】${userId || '成员'} 退出本群`;
        case 'group_recall':
            return `【群事件】${operatorId || userId || '成员'} 撤回了一条消息`;
        case 'friend_recall':
            return `【好友事件】${userId || '好友'} 撤回了一条消息`;
        case 'friend_add':
            return `【好友事件】已与 ${userId || '新好友'} 成为好友`;
        default:
            return '';
    }
}
