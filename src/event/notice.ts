import { FACE_MAP } from "../config/static_config";
import { truncateText } from "../utils/string";

// 依赖事件 → 文本提示词：纯函数转换 + 去重守卫（ob11 依赖 notice/request 事件）

/** 事件级去重窗口：同 key 事件在此窗口内只记录一次（原生回调与 ob11 依赖双路径防双录；
 *  去重命中时以最后到达的事件为唯一事件，见 pipeline.recordEventPrompt） */
export const EVENT_DEDUP_WINDOW_MS = 3000;
/** 去重表最大条目数：超限时淘汰最旧一项，防极端洪峰下内存失控 */
const EVENT_DEDUP_MAX = 5000;
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
    if (eventDedupMap.size > EVENT_DEDUP_MAX) {
        const oldest = eventDedupMap.keys().next().value;
        if (oldest !== undefined) eventDedupMap.delete(oldest);
    }
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

/**
 * 通知事件是否命中白名单：
 * - notify 大类按子类型精确匹配（避免只加了 notify 就把 gray_tip/input_status 等噪音全收进来；
 *   各 notify 子类型需单独在白名单内才会收录）；
 * - 其余类型按 notice_type 匹配，也兼容按子类型匹配（如 group_decrease 的 kick）。
 */
export function isNoticeInWhitelist(noticeType: string, subType: string, whitelist: Set<string>): boolean {
    if (!noticeType) return false;
    if (noticeType === 'notify') return !!subType && whitelist.has(subType);
    return whitelist.has(noticeType) || (!!subType && whitelist.has(subType));
}

/**
 * 机器人自身相关的群增减通知（user_id === self_id）：入群 / 被移出 / 主动退群。
 * 这类事件原生回调（onGroupJoined / onGroupLeave）已经覆盖，ob11 依赖侧应跳过，
 * 否则同一条物理事件会在两条路径上以不同 eventType / 不同文本各录一次（去重 key 拼不上）。
 */
export function isSelfCoveredNoticeEvent(noticeType: string, userId: any, selfId: any): boolean {
    if (noticeType !== 'group_increase' && noticeType !== 'group_decrease') return false;
    if (userId === undefined || userId === null || selfId === undefined || selfId === null) return false;
    return String(userId) === String(selfId);
}

/** 事件去重 key：epId + 会话 + 事件类型 + 用户 + 消息ID + 内容指纹。
 *  窗口内同 key 视为同一事件双路径/重复到达（应去重）；
 *  指纹段细分"同一 eventType 下内容不同"的事件，避免 3s 窗口吞掉连续但不同的事件。 */
export function buildEventDedupKey(epId: string, sessionId: string, eventType: string, userId: string, messageId: string = '', extra: string = ''): string {
    return `${epId}|${sessionId}|${eventType}|${userId}|${messageId}|${extra}`;
}

/** 原生回调已覆盖、与 ob11 依赖双路径重叠的通知类型：
 *  这类事件必须由两条路径按同一套（摘要）字段拼 key——原生回调只能提供 noticeType/userId 等
 *  摘要，复现不了整包指纹，故不指纹、返回空串；它们的不同事件已由 userId/messageId/eventType 区分。 */
const NATIVE_OVERLAP_NOTICE_TYPES = new Set([
    'group_increase',
    'group_decrease',
    'group_recall',
    'friend_recall',
    'friend_add',
    'group_joined',
]);

/**
 * 事件"内容指纹"：把 3s 去重窗口内连续但内容不同的事件彻底拆开（通用方案，不再按类型枚举）。
 *
 * 原理：同一条物理事件被重复投递/双路径 echo 时，载荷完全一致；两条内容不同的事件必然在
 * 载荷的某个字段上有差异。因此对整包做规范化指纹：
 * - 内容不同的事件 → 指纹不同 → key 不同 → 后者不再被吞（自动覆盖任意现有/未来/自定义类型）；
 * - 同一事件重复到达 → 指纹相同 → 照常去重。
 *
 * 例外：NATIVE_OVERLAP_NOTICE_TYPES 内类型不指纹（见上）；请求类（request）没有 notice_type，
 * 走整包指纹，天然按 flag/comment/user 等区分不同请求。
 */
export function buildEventDedupExtra(event: any): string {
    if (!event || typeof event !== 'object') return '';
    const noticeType = String(event.notice_type || '');
    if (noticeType && NATIVE_OVERLAP_NOTICE_TYPES.has(noticeType)) return '';
    return fnv1a(canonicalJson(event));
}

/** raw 是否为 ob11 原始事件载荷（原生路径传的是 info 摘要，无 notice_type/request_type/post_type，不会误判） */
export function isOb11EventPayload(raw: any): boolean {
    if (!raw || typeof raw !== 'object') return false;
    return typeof raw.notice_type === 'string'
        || typeof raw.request_type === 'string'
        || typeof raw.post_type === 'string';
}

/** 递归规范化：对象键排序、剔除 undefined，保证同一事件不同投递/不同键序得到相同指纹输入 */
function canonicalJson(value: any): string {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (t === 'string') return JSON.stringify(value);
    if (t === 'boolean') return value ? 'true' : 'false';
    if (t === 'undefined' || t === 'function' || t === 'symbol') return '';
    if (Array.isArray(value)) {
        let out = '[';
        for (let i = 0; i < value.length; i++) {
            if (i > 0) out += ',';
            out += canonicalJson(value[i]);
        }
        return out + ']';
    }
    const keys = Object.keys(value).sort();
    let out = '{';
    let first = true;
    for (const k of keys) {
        const v = value[k];
        if (v === undefined) continue;
        if (!first) out += ',';
        first = false;
        out += JSON.stringify(k) + ':' + canonicalJson(v);
    }
    return out + '}';
}

/** FNV-1a 32 位哈希 → base36 短串：把整包指纹压成定长 key 段（容量有界，碰撞概率在窗口规模内可忽略） */
function fnv1a(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
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

/** 表情回应 emoji_id → 中文名（QQ 表情表），未知保留原始 id 便于排查 */
function formatEmojiId(id: any): string {
    const key = String(id);
    return FACE_MAP[key] || `表情${key}`;
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
        case 'group_card':
            return `【群事件】${user || '成员'} 的群名片由「${event.card_old || '未知'}」变更为「${event.card_new || '未知'}」`;
        case 'notify': {
            if (subType === 'lucky_king') return `【群事件】${user || '群成员'} 抢到了运气王红包`;
            if (subType === 'honor') return `【群事件】${user || '群成员'} 获得群荣誉「${event.honor_type || '未知荣誉'}」`;
            if (subType === 'poke') return ''; // poke 由原生 onPoke 处理，不在这里录
            if (subType === 'group_name') return `【群事件】群名称变更为「${event.name_new || event.group_name || '未知'}」`;
            if (subType === 'title') return `【群事件】${user || '群成员'} 的头衔变更为「${event.title || '未知'}」`;
            if (subType === 'profile_like') {
                const liker = uniUserId(event.operator_id, prefix);
                const times = event.times && Number(event.times) > 1 ? `（×${event.times}）` : '';
                return `【资料事件】${liker || event.operator_nick || '有人'} 点赞了你的资料${times}`;
            }
            if (subType === 'gray_tip') return `【群事件】${user || '成员'} 触发灰条消息（busi_id: ${event.busi_id || '未知'}）`;
            if (subType === 'input_status') return ''; // 输入状态纯噪音，不收录
            return `【群事件】${user || '群成员'} 触发通知（${subType}）`;
        }
        case 'group_increase':
            return `【群事件】${user || '成员'} 加入本群${operator ? `（由 ${operator} ${subType === 'invite' ? '邀请' : '通过'}）` : ''}`;
        case 'group_decrease': {
            if (subType === 'disband') return `【群事件】本群已解散`;
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
        case 'essence': {
            const sender = uniUserId(event.sender_id, prefix);
            return `【群事件】${operator || '管理员'} 将 ${sender || '成员'} 的消息${event.sub_type === 'delete' ? '取消' : '设为'}精华`;
        }
        case 'group_msg_emoji_like': {
            const likes = Array.isArray(event.likes) ? event.likes : [];
            const emojiText = likes
                .map((l: any) => {
                    const cnt = l && l.count && Number(l.count) > 1 ? `(×${l.count})` : '';
                    return `「${l ? formatEmojiId(l.emoji_id) : '未知表情'}」${cnt}`;
                })
                .join('、');
            const action = event.is_add === false ? '取消' : '添加';
            return `【群事件】${user || '有成员'} 对消息${action}了表情${emojiText || '（未知）'}`;
        }
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
    const hint = '（完整事件数据可用 read_raw kind=event 查看，处理申请需要）';
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
