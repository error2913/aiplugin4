// 事件触发规则（叶子纯逻辑，L2）：配置 JSON v1 的解析校验 / 事件视图匹配 / 触发提示渲染 / 硬排除。
//
// 设计约束（见 .dev/issue-147-event-trigger-plan.md）：
// - 触发发生在「事件已按现有接收链路进入上下文」之后，本模块只做纯匹配与文本生成；
// - 不依赖 seal / Config / session / prompt，便于单测与跨仓库联测；
// - 解析失败一次报全（路径形如 $.rules[0].prompt），由调用方整份拒绝并回退空规则集。
import { parseJSONWithTrailingCommas } from '../utils/json';
import { stripInternalTags, stripUserTags } from '../utils/render_tags';
import { matchesPlatform } from '../utils/target_id';

export const EVENT_TRIGGER_VERSION = 1;
export const EVENT_TRIGGER_RULES_MAX = 50;
export const EVENT_TRIGGER_MATCH_MAX = 10;
export const EVENT_TRIGGER_PROMPT_MAX = 4000;
export const EVENT_TRIGGER_EVENT_JSON_MAX = 2000;
export const EVENT_TRIGGER_SCOPE_SESSIONS_MAX = 200;
export const EVENT_TRIGGER_DEFAULT_JSON = '{"version":1,"rules":[]}';

/** 规则 match 可用的字段白名单（均为 EventView 的计算字段） */
export const EVENT_TRIGGER_FIELDS = [
    'event_type',
    'post_type',
    'notice_type',
    'sub_type',
    'request_type',
    'user_id',
    'operator_id',
    'group_id',
    'message_id',
    'is_group',
    'is_target_bot',
    'platform',
    'session_id',
] as const;

export type EventTriggerField = typeof EVENT_TRIGGER_FIELDS[number];
export type EventTriggerPostType = 'notice' | 'request' | 'poke';

/**
 * 已知事件名（扁平）：生成器下拉与插件校验共用这一份口径。
 * `profile_like` 保留在集合内（协议端会上报）但触发侧硬排除，生成器不提供。
 */
export const EVENT_TRIGGER_KNOWN_EVENTS = [
    'group_increase',
    'group_decrease',
    'group_admin',
    'group_ban',
    'group_recall',
    'group_upload',
    'group_card',
    'group_msg_emoji_like',
    'essence',
    'group_joined',
    'poke',
    'group_name',
    'title',
    'honor',
    'lucky_king',
    'profile_like',
    'friend_add',
    'friend_recall',
    'group_request',
    'friend_request',
] as const;

export interface EventTriggerCondition {
    field: EventTriggerField;
    regex?: string;
    equals?: string | number | boolean;
    /** 解析期编译的正则（不回写 JSON） */
    _re?: RegExp;
}

export interface EventTriggerScope {
    platforms: string[];
    sessions: string[];
    exclude: string[];
}

export interface EventTriggerRule {
    /** 单个扁平事件名（一规则一事件），如 group_increase / poke */
    on: string;
    scope: EventTriggerScope;
    match: EventTriggerCondition[];
    prompt: string;
}

export interface EventTriggerConfig {
    version: number;
    rules: EventTriggerRule[];
}

export interface EventTriggerIssue {
    path: string;
    msg: string;
}

export interface EventTriggerParseResult {
    /** 有任何一个 issue 时为 null（整份拒绝） */
    config: EventTriggerConfig | null;
    issues: EventTriggerIssue[];
    warnings: EventTriggerIssue[];
}

/** 统一事件视图：notice / request / poke 三条来源在触发匹配前都归一成它 */
export interface EventView {
    source: EventTriggerPostType;
    postType: EventTriggerPostType;
    /** 匹配键：notice 非 notify 用 notice_type；notify 用 sub_type 扁平名；request 用 `<request_type>_request`；poke 用 `poke` */
    eventType: string;
    noticeType: string;
    requestType: string;
    subType: string;
    userId: string;
    operatorId: string;
    groupId: string;
    messageId: string;
    targetId: string;
    isTargetBot: boolean;
    epId: string;
    platform: string;
    botId: string;
    sid: string;
    isPrivate: boolean;
    eventText: string;
    flag: string;
    comment: string;
    raw?: unknown;
    receivedAt: number;
}

export function eventTypeOfNotice(noticeType: string, subType: string): string {
    // notify 大类使用扁平子类型名（poke / group_name / title / honor / lucky_king / profile_like …）
    return noticeType === 'notify' ? (subType || 'unknown') : noticeType;
}

export function eventTypeOfRequest(requestType: string): string {
    return `${requestType}_request`;
}

function issue(path: string, msg: string): EventTriggerIssue {
    return { path, msg };
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 平台/会话列表：接受数组或逗号/换行分隔字符串 */
function readStringList(value: unknown, path: string, issues: EventTriggerIssue[], max = EVENT_TRIGGER_SCOPE_SESSIONS_MAX): string[] {
    if (value === undefined || value === null) return [];
    let list: unknown[];
    if (typeof value === 'string') {
        list = value.split(/[,，\n]/);
    } else if (Array.isArray(value)) {
        list = value;
    } else {
        issues.push(issue(path, '必须是字符串或字符串数组'));
        return [];
    }
    const out: string[] = [];
    for (const item of list) {
        if (typeof item !== 'string') {
            issues.push(issue(path, '列表项必须是字符串'));
            continue;
        }
        const text = item.trim();
        if (text) out.push(text);
    }
    if (out.length > max) {
        issues.push(issue(path, `最多 ${max} 项（当前 ${out.length}）`));
    }
    return out;
}

/** UNI-ID 形状只做提示（不同适配器可能有别的写法），不阻断 */
function warnSessionIdShape(list: string[], path: string, warnings: EventTriggerIssue[]): void {
    for (let i = 0; i < list.length; i++) {
        if (!/^[^\s:]+:(.+)$/.test(list[i]) && !/^[^\s:]+-Group:(.+)$/.test(list[i])) {
            warnings.push(issue(`${path}[${i}]`, `「${list[i]}」不是 UNI-ID（示例：QQ-Group:123456 / QQ:123456），不会命中`));
        }
    }
}

function readScope(value: unknown, path: string, issues: EventTriggerIssue[], warnings: EventTriggerIssue[]): EventTriggerScope {
    if (value === undefined || value === null) return { platforms: [], sessions: [], exclude: [] };
    if (!isPlainObject(value)) {
        issues.push(issue(path, '必须是对象'));
        return { platforms: [], sessions: [], exclude: [] };
    }
    for (const key of Object.keys(value)) {
        if (!['platforms', 'sessions', 'exclude'].includes(key)) warnings.push(issue(`${path}.${key}`, '未知字段，已忽略'));
    }
    const platforms = readStringList(value.platforms, `${path}.platforms`, issues, 20);
    const sessions = readStringList(value.sessions, `${path}.sessions`, issues);
    const exclude = readStringList(value.exclude, `${path}.exclude`, issues);
    warnSessionIdShape(sessions, `${path}.sessions`, warnings);
    warnSessionIdShape(exclude, `${path}.exclude`, warnings);
    return { platforms, sessions, exclude };
}

function readEventName(value: unknown, path: string, issues: EventTriggerIssue[], warnings: EventTriggerIssue[]): string {
    if (Array.isArray(value)) {
        issues.push(issue(path, '一条规则只绑定一个事件：on 必须是字符串（多个事件请建多条规则）'));
        return '';
    }
    if (typeof value !== 'string' || !value.trim()) {
        issues.push(issue(path, 'on 必填（事件名，如 group_increase / poke / group_request）'));
        return '';
    }
    const token = value.trim();
    if (!/^[a-z0-9_]+$/.test(token)) {
        issues.push(issue(path, `非法事件名「${token}」（示例：group_increase / poke / group_request）`));
        return '';
    }
    if (!(EVENT_TRIGGER_KNOWN_EVENTS as readonly string[]).includes(token)) {
        warnings.push(issue(path, `未知事件名「${token}」，若协议端未上报将不会触发`));
    }
    return token;
}

function readMatch(value: unknown, path: string, issues: EventTriggerIssue[], warnings: EventTriggerIssue[]): EventTriggerCondition[] {
    if (value === undefined || value === null) return [];
    let list: unknown[];
    if (Array.isArray(value)) {
        list = value;
    } else if (isPlainObject(value)) {
        // 对象糖：{"sub_type":"leave","is_target_bot":true} → 等值条件（正则请用数组形态）
        const out: EventTriggerCondition[] = [];
        for (const [field, rawValue] of Object.entries(value)) {
            if (!(EVENT_TRIGGER_FIELDS as readonly string[]).includes(field)) {
                issues.push(issue(`${path}.${field}`, `字段必须是 ${EVENT_TRIGGER_FIELDS.join(' / ')} 之一`));
                continue;
            }
            if (rawValue === null || rawValue === undefined || typeof rawValue === 'object') {
                issues.push(issue(`${path}.${field}`, '对象形态的值只支持字符串/数字/布尔（正则请用数组形态）'));
                continue;
            }
            out.push({ field: field as EventTriggerField, equals: rawValue as string | number | boolean });
        }
        return out;
    } else {
        issues.push(issue(path, '必须是数组或对象（对象形态示例：{"sub_type":"leave"}）'));
        return [];
    }
    if (list.length > EVENT_TRIGGER_MATCH_MAX) {
        issues.push(issue(path, `最多 ${EVENT_TRIGGER_MATCH_MAX} 条条件（当前 ${list.length}）`));
    }
    const out: EventTriggerCondition[] = [];
    for (let i = 0; i < list.length; i++) {
        const itemPath = `${path}[${i}]`;
        if (!isPlainObject(list[i])) {
            issues.push(issue(itemPath, '必须是对象（{field, regex} 或 {field, equals}）'));
            continue;
        }
        const item: Record<string, any> = list[i];
        for (const key of Object.keys(item)) {
            if (!['field', 'regex', 'equals'].includes(key)) warnings.push(issue(`${itemPath}.${key}`, '未知字段，已忽略'));
        }
        if (typeof item.field !== 'string' || !(EVENT_TRIGGER_FIELDS as readonly string[]).includes(item.field)) {
            issues.push(issue(`${itemPath}.field`, `字段必须是 ${EVENT_TRIGGER_FIELDS.join(' / ')} 之一`));
            continue;
        }
        const hasRegex = item.regex !== undefined && item.regex !== null;
        const hasEquals = item.equals !== undefined && item.equals !== null;
        if (hasRegex === hasEquals) {
            issues.push(issue(itemPath, 'regex 与 equals 必须二选一'));
            continue;
        }
        if (hasRegex) {
            if (typeof item.regex !== 'string') {
                issues.push(issue(`${itemPath}.regex`, '必须是字符串'));
                continue;
            }
            try {
                out.push({ field: item.field as EventTriggerField, regex: item.regex, _re: new RegExp(item.regex) });
            } catch (e) {
                issues.push(issue(`${itemPath}.regex`, `正则编译失败：${e instanceof Error ? e.message : String(e)}`));
            }
            continue;
        }
        const equals = item.equals;
        if (typeof equals !== 'string' && typeof equals !== 'number' && typeof equals !== 'boolean') {
            issues.push(issue(`${itemPath}.equals`, '只支持字符串/数字/布尔'));
            continue;
        }
        out.push({ field: item.field as EventTriggerField, equals });
    }
    return out;
}

/**
 * 解析「事件触发规则」JSON（v1）。空文本 = 空规则集；任何 issue → config 为 null（调用方整份拒绝）。
 */
export function parseEventTriggerConfig(text: string): EventTriggerParseResult {
    const issues: EventTriggerIssue[] = [];
    const warnings: EventTriggerIssue[] = [];
    const raw = String(text ?? '').trim();
    if (!raw) return { config: { version: EVENT_TRIGGER_VERSION, rules: [] }, issues, warnings };

    let value: any;
    try {
        value = parseJSONWithTrailingCommas(raw);
    } catch (e) {
        issues.push(issue('$', `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`));
        return { config: null, issues, warnings };
    }
    if (!isPlainObject(value)) {
        issues.push(issue('$', '必须是 JSON 对象'));
        return { config: null, issues, warnings };
    }
    for (const key of Object.keys(value)) {
        if (!['version', 'rules'].includes(key)) warnings.push(issue(`$.${key}`, '未知字段，已忽略'));
    }

    if (value.version === undefined || value.version === null) {
        warnings.push(issue('$.version', `缺少 version，按 ${EVENT_TRIGGER_VERSION} 处理`));
    } else if (value.version !== EVENT_TRIGGER_VERSION) {
        issues.push(issue('$.version', `版本不支持：${JSON.stringify(value.version)}（当前只支持 ${EVENT_TRIGGER_VERSION}）`));
    }

    if (!Array.isArray(value.rules)) {
        issues.push(issue('$.rules', '必须是数组'));
        return { config: null, issues, warnings };
    }
    if (value.rules.length > EVENT_TRIGGER_RULES_MAX) {
        issues.push(issue('$.rules', `最多 ${EVENT_TRIGGER_RULES_MAX} 条规则（当前 ${value.rules.length}）`));
    }

    const rules: EventTriggerRule[] = [];
    value.rules.forEach((item: unknown, index: number) => {
        const path = `$.rules[${index}]`;
        if (!isPlainObject(item)) {
            issues.push(issue(path, '必须是对象'));
            return;
        }
        for (const key of Object.keys(item)) {
            if (!['on', 'scope', 'match', 'prompt'].includes(key)) {
                warnings.push(issue(`${path}.${key}`, '未知字段，已忽略（规则不再支持 name / toolChoice）'));
            }
        }
        const on = readEventName(item.on, `${path}.on`, issues, warnings);
        const scope = readScope(item.scope, `${path}.scope`, issues, warnings);
        const match = readMatch(item.match, `${path}.match`, issues, warnings);
        const prompt = typeof item.prompt === 'string' ? item.prompt : '';
        if (!prompt.trim()) {
            issues.push(issue(`${path}.prompt`, 'prompt 必填（触发时给 AI 的指令）'));
        } else if (prompt.length > EVENT_TRIGGER_PROMPT_MAX) {
            issues.push(issue(`${path}.prompt`, `prompt 最多 ${EVENT_TRIGGER_PROMPT_MAX} 字（当前 ${prompt.length}）`));
        }
        rules.push({ on, scope, match, prompt });
    });

    if (issues.length > 0) return { config: null, issues, warnings };
    return { config: { version: EVENT_TRIGGER_VERSION, rules }, issues, warnings };
}

function viewFieldValue(view: EventView, field: EventTriggerField): string | boolean {
    switch (field) {
        case 'event_type': return view.eventType;
        case 'post_type': return view.postType;
        case 'notice_type': return view.noticeType;
        case 'sub_type': return view.subType;
        case 'request_type': return view.requestType;
        case 'user_id': return view.userId;
        case 'operator_id': return view.operatorId;
        case 'group_id': return view.groupId;
        case 'message_id': return view.messageId;
        case 'is_group': return !view.isPrivate;
        case 'is_target_bot': return view.isTargetBot;
        case 'platform': return view.platform;
        case 'session_id': return view.sid;
        default: return '';
    }
}

/** 命中第一条规则（顺序 = 优先级）；无命中返回 null */
export function matchEventTrigger(rules: EventTriggerRule[], view: EventView): EventTriggerRule | null {
    for (const rule of rules) {
        if (rule.on !== view.eventType) continue;
        if (!matchesPlatform(rule.scope.platforms, view.platform)) continue;
        if (rule.scope.sessions.length > 0 && !rule.scope.sessions.includes(view.sid)) continue;
        if (rule.scope.exclude.includes(view.sid)) continue;
        let matched = true;
        for (const cond of rule.match) {
            const actual = viewFieldValue(view, cond.field);
            if (cond._re) {
                if (!cond._re.test(String(actual))) { matched = false; break; }
            } else if (String(actual) !== String(cond.equals)) {
                matched = false;
                break;
            }
        }
        if (matched) return rule;
    }
    return null;
}

/**
 * 硬排除：规则无法覆盖、触发后必然失败或无意义的事件。
 * - 机器人被移出群 / 群解散 / 机器人自己被禁言；
 * - 可伪造或纯噪音的 notify 子类型；陌生人私聊类（回复必失败）；
 * - 机器人自己发起的 poke。
 */
export function isEventTriggerExcluded(view: EventView): boolean {
    if (!view.eventType) return true;
    if (view.eventType === 'profile_like' || view.eventType === 'gray_tip' || view.eventType === 'input_status') return true;
    if (view.noticeType === 'group_decrease' && (view.subType === 'kick_me' || view.subType === 'disband')) return true;
    if (view.noticeType === 'group_ban' && view.userId && view.userId === view.botId) return true;
    if (view.source === 'poke' && view.userId && view.userId === view.botId) return true;
    return false;
}

function safeText(value: unknown): string {
    return stripUserTags(String(value ?? ''));
}

/** 渲染触发指令里的占位符（事件数据先按用户输入口径清洗，防注入） */
export function renderTriggerPrompt(template: string, view: EventView): string {
    const sentinel = '\u0000';
    const withEscape = String(template ?? '').replace(/\{\{/g, sentinel);

    const values: Record<string, string> = {
        event_text: safeText(view.eventText),
        event_json: safeText(JSON.stringify(view.raw ?? {})).slice(0, EVENT_TRIGGER_EVENT_JSON_MAX),
        event_type: safeText(view.eventType),
        post_type: safeText(view.postType),
        notice_type: safeText(view.noticeType),
        request_type: safeText(view.requestType),
        sub_type: safeText(view.subType),
        user_id: safeText(view.userId),
        operator_id: safeText(view.operatorId),
        group_id: safeText(view.groupId),
        message_id: safeText(view.messageId),
        target_id: safeText(view.targetId),
        session_id: safeText(view.sid),
        platform: safeText(view.platform),
        flag: safeText(view.flag),
        comment: safeText(view.comment),
    };

    const rendered = withEscape.replace(/\{([A-Za-z0-9_.\-]+)\}/g, (_all, name: string) => values[name] ?? '');
    const restored = rendered.split(sentinel).join('{');
    const cleaned = stripInternalTags(restored);
    return cleaned.length > EVENT_TRIGGER_PROMPT_MAX
        ? cleaned.slice(0, EVENT_TRIGGER_PROMPT_MAX) + '…'
        : cleaned;
}
