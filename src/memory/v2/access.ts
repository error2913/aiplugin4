// 记忆访问控制/标签工具（纯函数）：scope、visibility、可见性判定、ID 解析。
// 规则（05 §2.3）：
// - user bank：owner=仅本人 DM；origin:<scope>=来源会话 + 本人 DM；public=本人 DM + 该用户发言的所有群
// - group bank：public/origin/owner 均=本群（bank 隔离已限制）
// - global bank：只允许 public；所有会话可见
import type { MemoryUnit, MentalModel, Observation, Visibility } from './types';

export const RESERVED_TAG_PREFIXES = ['user:', 'group:', 'global:', 'vis:', 'src:', 'kw:'] as const;

export interface ViewerContext {
    sessionId: string;
    sessionType: 'group' | 'user';
    /** 群聊时为群 ID；私聊时为用户 ID */
    groupId?: string;
    userId?: string;
    agentName?: string;
    isMaster?: boolean;
}

export function bankKindOf(bankId: string): 'user' | 'group' | 'global' {
    const prefix = String(bankId || '').split('_')[0];
    return prefix === 'user' || prefix === 'group' || prefix === 'global' ? prefix : 'global';
}

export function scopeTagFor(kind: 'user' | 'group' | 'global', id: string): string {
    if (kind === 'global') return `global:${id || 'main'}`;
    return `${kind}:${id}`;
}

export function visibilityTag(visibility: Visibility, originScope?: string): string {
    if (visibility === 'public') return 'vis:public';
    if (visibility === 'owner') return 'vis:owner';
    return `vis:origin:${originScope || ''}`;
}

export function isReservedTag(tag: string): boolean {
    const t = String(tag || '');
    return RESERVED_TAG_PREFIXES.some(prefix => t.startsWith(prefix));
}

/** 外部输入（模型/用户）不允许携带保留前缀，防止伪造归属/可见性。 */
export function sanitizeExternalTags(tags: string[] | undefined): string[] {
    return (tags || [])
        .map(t => String(t || '').trim())
        .filter(t => t && !isReservedTag(t))
        .map(t => (t.startsWith('kw:') ? t : `kw:${t}`));
}

export function getVisibility(tags: string[] | undefined): Visibility {
    const t = tags || [];
    // owner 比 origin 更严格：混合标签按 owner 处理，避免群内泄露
    if (t.includes('vis:owner')) return 'owner';
    if (t.some(x => x.startsWith('vis:origin:'))) return 'origin';
    return 'public';
}

export function getOriginScope(tags: string[] | undefined): string | undefined {
    const tag = (tags || []).find(x => x.startsWith('vis:origin:'));
    return tag ? tag.slice('vis:origin:'.length) : undefined;
}

export function getScopeTags(tags: string[] | undefined): string[] {
    return (tags || []).filter(t => /^(user|group|global):/.test(t));
}

function isSameUserBank(viewer: ViewerContext, bankId: string): boolean {
    const id = bankId.replace(/^user_/, '');
    return viewer.userId === id || viewer.sessionId === id;
}

function isSameGroupBank(viewer: ViewerContext, bankId: string): boolean {
    const id = bankId.replace(/^group_/, '');
    return viewer.groupId === id || (viewer.sessionType === 'group' && viewer.sessionId === id);
}

/** 事实/观察/模型统一可见性判定（不含 master 例外）。 */
export function canReadByTags(bankId: string, tags: string[] | undefined, viewer: ViewerContext): boolean {
    const kind = bankKindOf(bankId);
    const visibility = getVisibility(tags);
    if (kind === 'global') return visibility === 'public';
    if (kind === 'group') return isSameGroupBank(viewer, bankId);
    if (!isSameUserBank(viewer, bankId)) return false;
    if (viewer.sessionType === 'user') {
        // 本人 DM：owner/origin/public 均可见（origin 允许本人 DM 查看来源事实）
        return true;
    }
    // 本人发言的群：owner 永不可见；origin 仅来源群；public 全部群
    if (visibility === 'owner') return false;
    if (visibility === 'origin') return getOriginScope(tags) === viewer.groupId || getOriginScope(tags) === viewer.sessionId;
    return true;
}

export function canReadUnit(unit: MemoryUnit, viewer: ViewerContext): boolean {
    return canReadByTags(unit.bankId, unit.tags, viewer);
}

export function canReadObservation(obs: Observation, viewer: ViewerContext): boolean {
    return canReadByTags(obs.bankId, obs.tags, viewer);
}

export function globalScopeName(agentName?: string): string {
    return !agentName || agentName === '*' ? 'main' : agentName;
}

export function canReadModel(model: MentalModel, viewer: ViewerContext): boolean {
    const tags = model.tags || [];
    // 模型没有 visibility 标签：按 scope 任一带命中；空 tags 视为全局
    if (tags.length === 0) return true;
    const viewerTags = new Set<string>();
    if (viewer.userId) viewerTags.add(`user:${viewer.userId}`);
    if (viewer.groupId) viewerTags.add(`group:${viewer.groupId}`);
    viewerTags.add(`global:${globalScopeName(viewer.agentName)}`);
    return tags.some(t => viewerTags.has(t));
}

export function canMutateUnit(unit: MemoryUnit, viewer: ViewerContext): boolean {
    return canReadUnit(unit, viewer) || !!viewer.isMaster;
}

/** 解析 ID 或列表序号（#3 / 3）。 */
export function parseIdOrIndex(input: string | undefined, ids: string[]): string | null {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const m = raw.match(/^#?(\d+)$/);
    if (m) {
        const idx = Number(m[1]) - 1;
        return ids[idx] || null;
    }
    return raw;
}

export function uniq<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}
