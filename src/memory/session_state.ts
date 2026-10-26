// 会话记忆状态：只保留持久化字段与旧调用方的薄适配；实际读写统一走 MemoryService。
import type { GroupInfo, UserInfo } from "../session/types";
import { TypeDescriptor } from "../utils/revive";
import { truncateText } from "../utils/string";

import { MemoryService } from "./service";
import type { MemoryUnit, RecallHit, RecallOptions, RetainResult } from "./v2/types";

export function parseLooseJson(text: string): any {
    if (!text || typeof text !== 'string') return null;
    let s = text.trim();
    if (!s) return null;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); } catch { return null; }
}

const LEGACY_RENDER_LIMIT = 1000;

export default class SessionMemoryState {
    static validKeysMap: { [key in keyof SessionMemoryState]?: TypeDescriptor<SessionMemoryState[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        summaryStatus: 'boolean',
        summaryOverride: 'boolean',
        observationEnabled: 'boolean',
        persona: 'string',
    };
    agentName: string;
    sessionId: string;
    /** 旧字段保留迁移：新代码使用 observationEnabled */
    summaryStatus: boolean;
    summaryOverride?: boolean;
    observationEnabled?: boolean;
    persona: string;

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.summaryStatus = false;
        this.summaryOverride = undefined;
        this.observationEnabled = undefined;
        this.persona = '无';
    }

    private get scope(): { userId: string; groupId?: string; sessionType: 'user' | 'group' } {
        const group = /-Group:/.test(this.sessionId);
        return {
            userId: group ? '' : this.sessionId,
            groupId: group ? this.sessionId : undefined,
            sessionType: group ? 'group' : 'user',
        };
    }

    get bankId(): string {
        return MemoryService.bankIdForSessionId(this.sessionId);
    }

    get unitIds(): string[] {
        return MemoryService.listFactIds(this.bankId);
    }

    get memoryIds(): string[] {
        return this.unitIds;
    }

    get memories(): MemoryUnit[] {
        return MemoryService.listFacts(this.bankId, true);
    }

    async retainMemory(
        _ctx: seal.MsgContext | null,
        _session: unknown,
        ul: UserInfo[],
        gl: GroupInfo[],
        kws: string[],
        _images: unknown[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: string,
        importance = 0.5,
    ): Promise<RetainResult> {
        return MemoryService.retainForSessionId(this.sessionId, this.agentName, {
            content: text,
            relatedUserIds: (ul || []).map(u => u.id),
            relatedGroupIds: (gl || []).map(g => g.id),
            keywords: kws || [],
            visibility: visibility === 'private' ? 'owner' : 'public',
            metadata: { type: type || 'text' },
            importance,
        });
    }

    async recallMemory(query: string, options: Partial<RecallOptions> = {}): Promise<MemoryUnit[]> {
        const hits = await MemoryService.recallForSessionId(this.sessionId, this.agentName, query, options);
        return hits.filter(h => h.kind === 'fact' && h.unit).map(h => h.unit as MemoryUnit);
    }

    async addMemory(
        _ctx: seal.MsgContext | null,
        _session: unknown,
        ul: UserInfo[],
        gl: GroupInfo[],
        kws: string[],
        _images: unknown[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: string,
        importance = 0.5,
    ): Promise<RetainResult> {
        return this.retainMemory(null, null, ul, gl, kws, [], text, visibility, type, importance);
    }

    async deleteMemory(ids: string[]): Promise<number> {
        return MemoryService.deleteFacts(this.bankId, ids);
    }

    async clearMemory(): Promise<number> {
        return MemoryService.clearBank(this.bankId, false);
    }

    buildObservationPrompt(): string {
        return MemoryService.buildObservationSectionForBank(this.bankId);
    }

    buildMemory(): string {
        const list = this.memories;
        if (!list.length) return '暂无长期记忆';
        return [`记忆类型:${this.scope.sessionType === 'group' ? '群聊记忆' : '个人记忆'}`, '记忆列表:',
            ...list.map((m, i) => `${i + 1}. [${m.id}] ${truncateText(m.text, LEGACY_RENDER_LIMIT)}`)].join('\n');
    }

    getLatestMemoryListText(): string {
        return this.buildMemory();
    }

    findImage(_id: string): any { return null; }

    findMemoryAndImageByImageIdPrefix(_id: string): any { return null; }

    reviveMemoryMap(): void { /* v3 不再使用 map */ }
}

export { SessionMemoryState as SessionMemoryService };
export type { RecallHit };

