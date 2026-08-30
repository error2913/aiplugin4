// 会话记忆门面：只包装 Hindsight-like 新引擎，不再使用旧 MemoryService / MemoryItem。
import Agent from "../agent/agent";
import Config from "../config/config";
import { SUMMARY_TEMPLATE } from "../prompt/templates";
import Image from "../resource/image";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import { truncateText } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";

import { bumpMemoryRevision } from "./revision";
import { resolveBankId } from "./v2/bank_resolver";
import { getMemoryEngine } from "./v2/index";
import type { MemoryUnit, RecallOptions, RetainResult } from "./v2/types";

const MEMORY_RENDER_LIMIT = 1000;

export function parseLooseJson(text: string): any {
    if (!text || typeof text !== 'string') return null;
    let s = text.trim();
    if (!s) return null;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try {
        return JSON.parse(s);
    } catch (_e) {
        return null;
    }
}

export default class SessionMemoryService {
    static validKeysMap: { [key in keyof SessionMemoryService]?: TypeDescriptor<SessionMemoryService[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        summaryStatus: 'boolean',
        summaryOverride: 'boolean',
        persona: 'string'
    };
    agentName: string;
    sessionId: string;
    summaryStatus: boolean;
    summaryOverride?: boolean;
    persona: string;

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.summaryStatus = false;
        this.summaryOverride = undefined;
        this.persona = '无';
    }

    get agent(): Agent { return Agent.get(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }

    private get bankId(): string {
        const kind = this.sessionType === 'group' ? 'group' : 'user';
        return resolveBankId(this.sessionId, kind, this.agentName).bankId;
    }

    private get sessionType(): string {
        return this.session ? this.session.sessionType : 'user';
    }

    get unitIds(): string[] {
        return getMemoryEngine().repository.listUnits(this.bankId)
            .filter(u => u.state === 'valid')
            .map(u => u.id);
    }

    get memoryIds(): string[] {
        return this.unitIds;
    }

    get memories(): MemoryUnit[] {
        return getMemoryEngine().repository.listUnits(this.bankId)
            .filter(u => u.state === 'valid');
    }

    async retainMemory(
        _ctx: seal.MsgContext | null,
        _session: Session,
        ul: UserInfo[],
        gl: GroupInfo[],
        kws: string[],
        _images: unknown[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: string,
        importance = 0.5
    ): Promise<RetainResult> {
        const engine = getMemoryEngine();
        const tags = [
            ...ul.map(u => `user:${u.id}`),
            ...gl.map(g => `group:${g.id}`),
            ...kws,
            visibility === 'private' ? `vis:private:${this.sessionId}` : 'vis:public',
        ];
        const result = await engine.addMemory(this.bankId, {
            content: text,
            tags,
            metadata: { type: type || 'text' },
            importance,
            factType: type === 'event' ? 'experience' : 'world',
            verbatim: true,
        });
        bumpMemoryRevision();
        return result;
    }

    async recallMemory(query: string, options: Partial<RecallOptions> = {}): Promise<MemoryUnit[]> {
        const engine = getMemoryEngine();
        const callerSessionId = (options as any).sessionId || this.sessionId;
        const results = await engine.recall(this.bankId, query, {
            tags: options.tags,
            maxTokens: options.maxTokens || 2048,
            budget: options.budget || 'mid',
            types: ['world', 'experience', 'observation'],
        });
        return results
            .filter(r => canSeeUnit(r.unit, callerSessionId))
            .map(r => r.unit);
    }

    /** 删除指定记忆（按 ID 或关键词）：物理删除，彻底移除并释放存储空间 */
    deleteMemory(ids: string[] = [], kws: string[] = []) {
        const engine = getMemoryEngine();
        const units = engine.repository.listUnits(this.bankId);
        const targetIds = units
            .filter(u => u.state === 'valid' && (
                ids.includes(u.id) || (kws.length > 0 && kws.some(kw => u.tags.includes(kw)))
            ))
            .map(u => u.id);
        if (targetIds.length === 0) return;
        engine.repository.deleteUnits(this.bankId, targetIds);
        bumpMemoryRevision();
    }

    /** 清除全部长期记忆：物理删除，彻底移除并释放存储空间（观察记忆请用 .ai memo obs clr） */
    clearMemory() {
        const engine = getMemoryEngine();
        const targetIds = engine.repository.listUnits(this.bankId)
            .filter(u => u.state === 'valid')
            .map(u => u.id);
        if (targetIds.length === 0) return;
        engine.repository.deleteUnits(this.bankId, targetIds);
        bumpMemoryRevision();
    }

    clearMemories() {
        this.clearMemory();
    }

    buildMemory(si: { isPrivate: boolean; name: string; id?: string }, ml: MemoryUnit[]): string {
        if (ml.length === 0) return '';
        const listText = ml.map((m, i) => `${i + 1}. [${m.id}] ${m.text}`).join('\n');
        if (si.isPrivate) {
            return '记忆类型:个人记忆\n记忆列表:\n' + listText;
        }
        return '记忆类型:群聊记忆\n群聊名称:' + si.name + '\n记忆列表:\n' + listText;
    }

    getLatestMemoryListText(si: { isPrivate: boolean; name: string; id?: string }, p: number = 1): string {
        const units = this.memories;
        if (units.length === 0) return '';
        if (p > Math.ceil(units.length / 5)) p = Math.ceil(units.length / 5);
        const latest = units
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice((p - 1) * 5, p * 5);
        return this.buildMemory(si, latest) + `\n当前页码: ${p}/${Math.ceil(units.length / 5)}`;
    }

    buildObservationPrompt(): string {
        const { SUMMARY } = Config.memory;
        if (!SUMMARY) return '';
        const observations = getMemoryEngine().repository.listObservations(this.bankId);
        if (observations.length === 0) return '';
        return SUMMARY_TEMPLATE({
            "SUMMARY": SUMMARY,
            "summaries": observations.map(o => truncateText(o.text, MEMORY_RENDER_LIMIT))
        });
    }

    reviveMemoryMap() {
        // 新引擎无需旧存档复活逻辑
    }

    migrateLegacyTags() {
        // 新引擎不再存储旧 <|...|> 标签
    }

    accessMemories(_s: string): Promise<void> {
        return Promise.resolve();
    }

    async addMemory(
        ctx: seal.MsgContext | null,
        session: Session,
        ul: UserInfo[],
        gl: GroupInfo[],
        kws: string[],
        images: unknown[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: string,
        importance = 0.5
    ): Promise<RetainResult> {
        return this.retainMemory(ctx, session, ul, gl, kws, images, text, visibility, type, importance);
    }

    findImage(_id: string): Image | null {
        return null;
    }

    findMemoryAndImageByImageIdPrefix(_id: string): { memory: MemoryUnit; image: Image } | null {
        return null;
    }

}

function canSeeUnit(unit: MemoryUnit, callerSessionId: string): boolean {
    const privateTags = unit.tags.filter(t => t.startsWith('vis:private:'));
    if (privateTags.length === 0) return true;
    return privateTags.some(t => t === `vis:private:${callerSessionId}`);
}




