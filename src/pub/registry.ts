// 公开会话目录（Pub Registry）：跨会话/跨平台协作的目录存储与管理。
// 目录 = 一张扁平的"已公开会话"条目表，按 平台(一级) → botid(二级) 组织浏览；
// 条目由骰主用 .ai pub 维护，pub_read/pub_send 两个 AI 工具按目录读写。
// 存储 key：pubSessions（JSON）。ID 不做格式假设：通常为平台前缀形态（如 QQ:xxx / QQ-Group:xxx），
// 也接受非严格 UNI-ID 的字符串，按原样匹配与存储。
import { ext } from "../config/config";
import { logger } from "../logger";
import { getPlatform } from "../utils/target_id";
import { generateId } from "../utils/utils";

const log = logger.withTag('pub');

export interface PubSessionEntry {
    id: string;
    platform: string;      // 一级：目标平台（源自端点）
    botId: string;         // 二级：端点 userId（通常含平台前缀）
    sid: string;           // 会话 ID（群聊通常带 -Group: 标记；按原样存储，不强制形态）
    scope: 'group' | 'private';
    title: string;         // 展示名（给模型/列表看）
    desc: string;          // 管理者备注（可选）
    addedBy: string;       // 发布者（骰主）
    addedAt: number;       // 秒
    lastUsedAt: number;    // 秒
}

export interface PubGroupBot {
    botId: string;
    online: boolean;
    nickname: string;
    count: number;
}

export interface PubGroup {
    platform: string;
    bots: PubGroupBot[];
}

const STORAGE_KEY = 'pubSessions';

let cached: { version: number; entries: PubSessionEntry[] } | null = null;

/** 单个端点信息（seal.getEndPoints 投影，便于测试注入） */
interface EndpointLike {
    userId: string;
    platform?: string;
    state?: number;
    nickname?: string;
    enable?: boolean;
}

/** 端点查询钩子：默认走 seal.getEndPoints；测试可替换 */
function listEndpoints(): EndpointLike[] {
    try {
        return (seal.getEndPoints() as EndpointLike[]) || [];
    } catch (e) {
        log.debug(`读取端点列表失败: ${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
}

function load(): { version: number; entries: PubSessionEntry[] } {
    if (cached) return cached;
    try {
        const raw = ext.storageGet(STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (Array.isArray(data.entries)) {
                cached = { version: data.version || 1, entries: data.entries };
                return cached;
            }
        }
    } catch (e) {
        log.exception(`公开会话目录加载失败，按空目录处理`, e);
    }
    cached = { version: 1, entries: [] };
    return cached;
}

function save() {
    if (!cached) return;
    try {
        ext.storageSet(STORAGE_KEY, JSON.stringify(cached));
    } catch (e) {
        log.exception('公开会话目录保存失败', e);
    }
}

/** 归一化条目字段（读取存档时兜底类型错误/缺失字段）。
 *  sid 按原样接受——目录可能存非严格 UNI-ID 形态的会话 ID，不做格式假设，只要求非空。 */
function sanitizeEntry(raw: any): PubSessionEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const sid = String(raw.sid || '').trim();
    if (!sid) return null;
    const botId = String(raw.botId || '').trim();
    const platform = String(raw.platform || getPlatform(botId) || getPlatform(sid));
    const scope = sid.includes('-Group:') ? 'group' : 'private';
    return {
        id: String(raw.id || `p${generateId()}`),
        platform,
        botId: botId || `${platform || 'UNKNOWN'}:unknown`,
        sid,
        scope,
        title: String(raw.title || sid).slice(0, 80),
        desc: String(raw.desc || '').slice(0, 200),
        addedBy: String(raw.addedBy || ''),
        addedAt: Number(raw.addedAt) || 0,
        lastUsedAt: Number(raw.lastUsedAt) || 0,
    };
}

export function listEntries(): PubSessionEntry[] {
    const data = load();
    // 惰性清洗：出现脏条目就地修复一次并持久化，避免每次读取重复处理
    let dirty = false;
    const entries = data.entries.map((raw: any) => {
        const fixed = sanitizeEntry(raw);
        if (!fixed) { dirty = true; return null; }
        if (fixed.id !== raw.id || fixed.scope !== raw.scope || fixed.platform !== raw.platform) dirty = true;
        return fixed;
    }).filter((e: PubSessionEntry | null): e is PubSessionEntry => e !== null);
    if (dirty) {
        data.entries = entries;
        save();
    }
    return entries;
}

function persist(entries: PubSessionEntry[]) {
    cached = { version: 1, entries };
    save();
}

/** 生成目录内不重复的短 id */
function newEntryId(): string {
    let id = '';
    do {
        id = `p${generateId()}`;
    } while (listEntries().some(e => e.id === id));
    return id;
}

/** 按完整 id 精确查找 */
export function getEntryById(id: string): PubSessionEntry | null {
    return listEntries().find(e => e.id === id) || null;
}

/** id 前缀唯一命中：返回 { match, ambiguous }；未命中 match=null */
export function resolveEntryByPrefix(prefix: string): { match: PubSessionEntry | null; ambiguous: boolean } {
    const p = String(prefix || '').trim();
    if (!p) return { match: null, ambiguous: false };
    const hits = listEntries().filter(e => e.id.startsWith(p));
    if (hits.length === 1) return { match: hits[0], ambiguous: false };
    if (hits.length > 1) return { match: null, ambiguous: true };
    return { match: null, ambiguous: false };
}

/** 会话目标（pub_read / pub_send 使用）：支持目录条目 ID（前缀唯一）或 "botId/sid" 路径。
 *  目录仅用于感知/展示与标题回退；给出准确路径即可读/发，无需条目存在。 */
export interface PubTarget {
    botId: string;
    sid: string;
    platform: string;
    scope: 'group' | 'private';
    /** 目录条目标题（目录中存在该会话时回填），否则空 */
    title: string;
    /** 命中目录条目时为条目对象，路径直连时为 null */
    entry: PubSessionEntry | null;
}

/** 解析 pub 目标：优先按目录条目 ID 前缀；含 "/" 时按 "botId/sid" 路径解析（不要求目录存在）。
 *  botId / sid 作为目录存储键直接使用，不做格式校验——路径能对上存储即可读/发。 */
export function resolveSessionAddress(input: string): { match: PubTarget | null; reason?: string } {
    const s = String(input || '').trim();
    if (!s) return { match: null, reason: '会话参数为空' };

    const buildVirtual = (botId: string, sid: string): PubTarget => {
        const platform = getPlatform(botId) || '';
        const scope: 'group' | 'private' = sid.includes('-Group:') ? 'group' : 'private';
        const entry = listEntries().find(e => e.botId === botId && e.sid === sid) || null;
        return {
            botId,
            sid,
            platform: platform || entry?.platform || getPlatform(sid),
            scope: entry?.scope || scope,
            title: entry?.title || '',
            entry,
        };
    };

    if (s.includes('/')) {
        const slash = s.indexOf('/');
        const botId = s.slice(0, slash).trim();
        const sid = s.slice(slash + 1).trim();
        if (!botId || !sid) return { match: null, reason: `路径需同时包含 botId 与会话ID（如 QQ:123/QQ-Group:456），收到: ${s}` };
        return { match: buildVirtual(botId, sid) };
    }

    // 无 "/"：按目录条目 ID 前缀
    const { match, ambiguous } = resolveEntryByPrefix(s);
    if (ambiguous) return { match: null, reason: `条目ID前缀 <${s}> 有多个匹配，请使用更完整的 ID` };
    if (!match) return { match: null, reason: `目录中不存在条目 <${s}>；可直接用 botId/会话ID 路径（如 QQ:123/QQ-Group:456）` };
    return {
        match: {
            botId: match.botId,
            sid: match.sid,
            platform: match.platform,
            scope: match.scope,
            title: match.title,
            entry: match,
        }
    };
}

/** 添加/更新条目（同 botId+sid 视为同一条，更新元数据）；返回条目 */
export function upsertEntry(input: {
    platform: string; botId: string; sid: string; scope?: 'group' | 'private';
    title?: string; desc?: string; addedBy?: string;
}): PubSessionEntry {
    const entries = listEntries();
    const sid = String(input.sid || '').trim();
    if (!sid) throw new Error('会话 ID 不能为空');
    // scope 尽力推导（含 -Group: 视为群，其余归私聊）；不做 ID 格式假设
    const scope = input.scope || (sid.includes('-Group:') ? 'group' : 'private');
    let entry = entries.find(e => e.botId === input.botId && e.sid === sid);
    const now = Math.floor(Date.now() / 1000);
    if (!entry) {
        entry = {
            id: newEntryId(),
            platform: input.platform,
            botId: input.botId,
            sid,
            scope,
            title: String(input.title || sid).slice(0, 80),
            desc: String(input.desc || '').slice(0, 200),
            addedBy: String(input.addedBy || ''),
            addedAt: now,
            lastUsedAt: now,
        };
        entries.push(entry);
    } else {
        entry.title = String(input.title || entry.title || sid).slice(0, 80);
        if (input.desc !== undefined) entry.desc = String(input.desc).slice(0, 200);
        if (input.platform) entry.platform = input.platform;
        entry.lastUsedAt = now;
    }
    persist(entries);
    return entry;
}

export function removeEntry(id: string): boolean {
    const entries = listEntries();
    const next = entries.filter(e => e.id !== id);
    if (next.length === entries.length) return false;
    persist(next);
    return true;
}

/** 按过滤条件删除全部命中条目（.ai pub rm 使用）。过滤项缺省=不限；
 *  platform / botId / sid 按目录中存储的字符串原样匹配（不要求 UNI-ID 形态）。返回删除条数。 */
export function removeByFilters(filters: { platform?: string; botId?: string; sid?: string }): number {
    const entries = listEntries();
    const f = {
        platform: String(filters.platform ?? '').trim(),
        botId: String(filters.botId ?? '').trim(),
        sid: String(filters.sid ?? '').trim(),
    };
    if (!f.platform && !f.botId && !f.sid) return 0;
    const next = entries.filter(e => {
        if (f.platform && e.platform !== f.platform) return true;
        if (f.botId && e.botId !== f.botId) return true;
        if (f.sid && e.sid !== f.sid) return true;
        return false;
    });
    const removed = entries.length - next.length;
    if (removed > 0) persist(next);
    return removed;
}

/** 查找精确匹配 botId + sid 的条目（用于 .ai pub 无参操作本会话） */
export function getEntryBySession(botId: string, sid: string): PubSessionEntry | null {
    return listEntries().find(e => e.botId === botId && e.sid === sid) || null;
}

/** 清掉指向当前不在线端点的条目；返回移除数与剩余数 */
export function purgeOffline(): { removed: number; remain: number } {
    const entries = listEntries();
    const endpoints = listEndpoints();
    const onlineIds = new Set(endpoints.filter(e => Number(e.state) === 1).map(e => e.userId));
    const next = entries.filter(e => onlineIds.has(e.botId) || endpoints.length === 0);
    const removed = entries.length - next.length;
    if (removed > 0) persist(next);
    return { removed, remain: next.length };
}

/** 端点在线/昵称信息；端点不在列表中视为离线、昵称空 */
function endpointInfo(botId: string): { online: boolean; nickname: string } {
    const eps = listEndpoints();
    const ep = eps.find(e => e.userId === botId);
    if (!ep) return { online: false, nickname: '' };
    return { online: Number(ep.state) === 1, nickname: String(ep.nickname || ep.userId || '') };
}

/** 浏览一级：平台列表（含平台下各 bot 与公开会话数）。目录只用于感知展示，无权限过滤。 */
export function listGroups(): PubGroup[] {
    const entries = listEntries();
    const groups: { [platform: string]: Map<string, PubGroupBot> } = {};
    for (const e of entries) {
        if (!groups[e.platform]) groups[e.platform] = new Map();
        const map = groups[e.platform];
        const prev = map.get(e.botId);
        if (prev) prev.count += 1;
        else {
            const info = endpointInfo(e.botId);
            map.set(e.botId, { botId: e.botId, online: info.online, nickname: info.nickname, count: 1 });
        }
    }
    return Object.keys(groups).sort().map(platform => ({
        platform,
        bots: Array.from(groups[platform].values()).sort((a, b) => a.botId.localeCompare(b.botId)),
    }));
}

/** 浏览二级：某平台下 bot 列表（只统计实际有条目的 bot，避免把全部端点塞进目录） */
export function listPlatformBots(platform: string): PubGroupBot[] {
    const groups = listGroups();
    const g = groups.find(x => x.platform === platform);
    return g ? g.bots : [];
}

/** 浏览三级：某 bot 下的公开会话条目（无权限过滤） */
export function listBotEntries(botId: string): PubSessionEntry[] {
    return listEntries().filter(e => e.botId === botId);
}

/** 把当前会话公开到目录的便捷封装（.ai pub add 使用） */
export function publishCurrentSession(opts: {
    ctx: seal.MsgContext; sid: string;
    title?: string; desc?: string; addedBy?: string;
}): PubSessionEntry {
    const endPoint = opts.ctx.endPoint || ({} as seal.EndPointInfo);
    const platform = String(endPoint.platform || getPlatform(endPoint.userId || '') || getPlatform(opts.sid)).trim();
    const botId = String(endPoint.userId || '').trim();
    if (!platform || !botId) throw new Error('无法从当前上下文获取端点信息');
    if (!opts.sid) throw new Error('无法从当前上下文获取会话 ID');
    return upsertEntry({
        platform,
        botId,
        sid: opts.sid,
        title: opts.title,
        desc: opts.desc,
        addedBy: opts.addedBy,
    });
}

/** 判定平台是否支持 CQ 语义富媒体（QQ/OpenQQ 等 milky/CQ 系端点） */
export function isQQLikePlatform(platform: string): boolean {
    const p = String(platform || '').trim();
    return p === 'QQ' || p === 'OpenQQ' || p.startsWith('QQ-') || p === 'QQGuild';
}

/** 剥离消息中的 CQ 码（[CQ:xxx,..]），返回纯文本（不处理插件渲染标签） */
export function stripCQCode(s: string): string {
    return String(s || '').replace(/\[CQ:[^\]]*\]/gi, '');
}

/** 备注非 QQ 目标时的落库信息：目前只记平台族与富媒体可用性（v1 纯文本），预留 */
export function describePlatformCapability(platform: string): string {
    return isQQLikePlatform(platform)
        ? 'QQ系富媒体（at/图片/引用/face/poke）'
        : '纯文本（不支持 CQ/富媒体标签）';
}

// ---- 外发限频（按来源会话） ----
const sendHistory: { [sid: string]: number } = {};
/** 是否允许立即外发：距上次外发超过配置间隔（秒）；0 不限频 */
export function allowSendNow(sid: string, intervalSec: number): { ok: boolean; waitSec: number } {
    const interval = Number(intervalSec) || 0;
    if (interval <= 0) return { ok: true, waitSec: 0 };
    const last = sendHistory[sid] || 0;
    const elapsed = Date.now() - last;
    if (elapsed >= interval * 1000) return { ok: true, waitSec: 0 };
    return { ok: false, waitSec: Math.ceil((interval * 1000 - elapsed) / 1000) };
}
export function recordSend(sid: string) {
    sendHistory[sid] = Date.now();
}
export function resetSendHistoryForTest() {
    for (const k of Object.keys(sendHistory)) delete sendHistory[k];
}

/** 测试钩子：清空内存缓存（可传入种子条目数组） */
export function resetPubRegistryForTest(seed?: PubSessionEntry[]) {
    cached = { version: 1, entries: seed ? seed.map(sanitizeEntry).filter((e): e is PubSessionEntry => !!e) : [] };
    resetSendHistoryForTest();
}
