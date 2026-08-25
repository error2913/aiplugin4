// 会话记忆：观察记忆（调用摘要智能体）、事实落库、巩固与记忆 prompt 构建
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { SUMMARY_PROMPT_TEMPLATE, SUMMARY_TEMPLATE } from "../prompt/templates";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { buildContent } from "../utils/message";
import { stripInternalTags, truncateText } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";

import MemoryService from "./memory";
import MemoryItem from "./memory_item";
import { bumpMemoryRevision, bumpSummaryRevision } from "./revision";
import { resolveTargetSession } from "./session_target";
import { MemoryFact, MemoryFactResult, searchOptions } from "./types";
import { resolveBankId } from "./v2/bank_resolver";
import { getMemoryEngine } from "./v2/index";
import type { MemoryUnit } from "./v2/types";

const log = Logger.withTag('memory');

const MEMORY_RENDER_LIMIT = 1000;

/**
 * 宽容 JSON 解析：剥离 ```json 围栏、容忍前后缀文本、截取首个 {...}。
 * 解析失败返回 null（调用方降级处理，不再因模型格式问题丢失整次观察）。
 */
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

export default class SessionMemoryService extends MemoryService {
    static validKeysMap: { [key in keyof SessionMemoryService]?: TypeDescriptor<SessionMemoryService[key]> } = {
        memoryMap: { array: MemoryItem },
        agentName: 'string',
        sessionId: 'string',
        summaryStatus: 'boolean',
        summaryOverride: 'boolean',
        summaries: { array: 'string' },
        // 旧版本「短期记忆」字段：仅用于存档加载与迁移，新代码不再读写
        useShortMemory: 'boolean',
        shortMemoryList: { array: 'string' },
        persona: 'string'
    };
    agentName: string;
    sessionId: string;
    summaryStatus: boolean;
    summaryOverride?: boolean;
    summaries: string[];
    /** 旧版本「短期记忆」字段：仅用于存档加载与迁移（见 reviveMemoryMap） */
    useShortMemory?: boolean;
    shortMemoryList?: string[];
    /** 运行时状态：不持久化 */
    private summarizing: boolean;
    private consolidating: boolean;
    private summaryCount: number;

    constructor() {
        super();
        this.agentName = '';
        this.sessionId = '';
        this.summaryStatus = false;
        this.summaryOverride = undefined;
        this.summaries = [];
        this.summarizing = false;
        this.consolidating = false;
        this.summaryCount = 0;
    }

    private get bankId(): string {
        const kind = this.sessionType === 'group' ? 'group' : 'user';
        return resolveBankId(this.sessionId, kind, this.agentName).bankId;
    }

    private get sessionType(): string {
        return this.session ? this.session.sessionType : 'user';
    }

    override get memoryIds(): string[] {
        const engine = getMemoryEngine();
        return engine.repository.listUnits(this.bankId).filter(u => u.state === 'valid').map(u => u.id);
    }

    override get memories(): MemoryItem[] {
        const engine = getMemoryEngine();
        return engine.repository.listUnits(this.bankId)
            .filter(u => u.state === 'valid')
            .map(u => toLegacyMemoryItem(u));
    }

    override get users(): string[] {
        return Array.from(new Set(this.memories.reduce<string[]>((acc, m) => acc.concat(m.users), [])));
    }

    override get groups(): string[] {
        return Array.from(new Set(this.memories.reduce<string[]>((acc, m) => acc.concat(m.groups), [])));
    }

    override get tags(): string[] {
        return Array.from(new Set(this.memories.reduce<string[]>((acc, m) => acc.concat(m.tags), [])));
    }

    override get keywords(): string[] {
        return this.tags;
    }

    async retainMemory(
        _ctx: seal.MsgContext | null,
        _session: Session,
        ul: UserInfo[],
        gl: GroupInfo[],
        kws: string[],
        _images: Image[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: MemoryItem['type'],
        importance = 0.5
    ): Promise<MemoryFactResult> {
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
        return {
            action: result.action === 'merged' ? 'merged' : result.action === 'updated' ? 'updated' : result.action === 'noop' ? 'noop' : 'added',
            id: result.unitIds[0],
        };
    }

    async recallMemory(query: string, options: searchOptions): Promise<MemoryItem[]> {
        const engine = getMemoryEngine();
        const callerSessionId = options.sessionId || this.sessionId;
        const results = await engine.recall(this.bankId, query, {
            tags: options.tags,
            maxTokens: options.topK * 200,
            budget: 'mid',
            types: ['world', 'experience', 'observation'],
        });
        return results
            .filter(r => canSeeUnit(r.unit, callerSessionId))
            .map(r => toLegacyMemoryItem(r.unit));
    }

    override deleteMemory(ids: string[] = [], kws: string[] = []) {
        const engine = getMemoryEngine();
        const units = engine.repository.listUnits(this.bankId);
        const targets = units.filter(u => u.state === 'valid' && (
            ids.includes(u.id) || (kws.length > 0 && kws.some(kw => u.tags.includes(kw)))
        ));
        for (const u of targets) {
            const unit = engine.repository.getUnit(this.bankId, u.id);
            if (unit) {
                unit.state = 'invalidated';
                engine.repository.updateUnit(this.bankId, unit);
            }
        }
        if (targets.length > 0) bumpMemoryRevision();
    }

    override clearMemory() {
        const engine = getMemoryEngine();
        for (const u of engine.repository.listUnits(this.bankId)) {
            if (u.state !== 'valid') continue;
            u.state = 'invalidated';
            engine.repository.updateUnit(this.bankId, u);
        }
        bumpMemoryRevision();
    }

    override clearMemories() {
        this.clearMemory();
    }

    override async applyFact(fact: MemoryFact): Promise<MemoryFactResult> {
        if (fact.op === 'delete') {
            if (fact.existing_id) {
                const unit = this.repositoryUnit(fact.existing_id);
                if (unit) {
                    unit.state = 'invalidated';
                    getMemoryEngine().repository.updateUnit(this.bankId, unit);
                    bumpMemoryRevision();
                    return { action: 'deleted', id: unit.id };
                }
            }
            return { action: 'noop' };
        }
        if (fact.op === 'noop') return { action: 'noop' };
        const result = await this.addMemory(null, this.session, [], [], fact.keywords || [], [], fact.text || '', fact.visibility || 'public', fact.type, fact.importance);
        if (fact.existing_id && result.id) {
            const unit = this.repositoryUnit(fact.existing_id);
            if (unit) {
                unit.text = stripInternalTags(fact.text || '');
                unit.importance = fact.importance ?? unit.importance;
                getMemoryEngine().repository.updateUnit(this.bankId, unit);
                    bumpMemoryRevision();
                return { action: 'updated', id: unit.id };
            }
        }
        return result;
    }

    private repositoryUnit(unitId: string): MemoryUnit | null {
        return getMemoryEngine().repository.getUnit(this.bankId, unitId);
    }


    get agent(): Agent { return Agent.get(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }

    /** 旧存档迁移：历史「短期记忆」与「观察记忆」内容相同，统一并入观察记忆；开关合并到 summaryStatus */
    reviveMemoryMap() {
        super.reviveMemoryMap();
        if (Array.isArray(this.shortMemoryList) && this.shortMemoryList.length > 0) {
            this.summaries = Array.from(new Set([...this.summaries, ...this.shortMemoryList]));
            this.limitSummaries();
            this.shortMemoryList = [];
        }
        if (this.useShortMemory) {
            this.summaryStatus = true;
            this.useShortMemory = false;
        }
        // 旧版 summaryStatus=true 表示用户显式开启过观察；迁移为会话级 override=true
        if (this.summaryStatus === true && this.summaryOverride === undefined) {
            this.summaryOverride = true;
        }
    }
    // 观察记忆（每轮对话后由 context.addAssistantMessage 触发；增量：只观察上次游标之后的消息）
    async summarize() {
        // 会话级显式开关优先；未显式设置时跟随全局「启用观察记忆」
        if (this.summaryOverride === false) return;
        if (this.summaryOverride !== true && !Config.memory.SUMMARY) return;
        if (this.summarizing) return; // 重入保护
        this.summarizing = true;
        try {
            const { SUMMARY_SIZE } = Config.memory;
            const messages = this.session.context.messages;
            // 增量游标：上次观察位置；上下文被裁剪（limitMessages）导致游标越界时回退到 0 重新观察
            let start = this.session.context.lastSummarizedIndex || 0;
            if (start > messages.length) start = 0;
            let end = messages.length;
            let round = 0;
            for (let i = start; i < messages.length; i++) {
                if (messages[i].role === 'user') round++;
                if (round > SUMMARY_SIZE) {
                    end = i;
                    break;
                }
            }
            const sumMessages = messages.slice(start, end);
            if (sumMessages.length === 0) return;

            const roleSetting = (Config.message.ROLE_SETTINGS || [])[0] || '';
            const isPrivate = this.session.sessionType !== 'group';
            const sessionId = this.session.sessionId;
            const userNumber = isPrivate ? sessionId.replace(/^.+:/, '') : '';
            const groupNumber = isPrivate ? '' : sessionId.replace(/^.+:/, '');
            const userName = isPrivate ? (User.get(sessionId).userName || userNumber) : '';
            const groupName = isPrivate ? '' : (Group.get(sessionId).groupName || groupNumber);
            const prompt = SUMMARY_PROMPT_TEMPLATE({
                "角色设定": roleSetting,
                "平台": '',
                "私聊": isPrivate,
                "用户名称": userName,
                "用户号码": userNumber,
                "群聊名称": groupName,
                "群聊号码": groupNumber,
                "对话内容": sumMessages.map(message => {
                    const toolCalls = (message as any).toolCalls || (message as any).tool_calls;
                    if (message.role === 'assistant' && toolCalls && toolCalls.length > 0) {
                        return `\n[function_call]: ${toolCalls.map((tool_call: any, index: number) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
                    }
                    return `[${message.role}]: ${buildContent(message as any)}`;
                }).join('\n')
            });

            log.info('记忆观察prompt:\n', prompt);

            // 使用摘要智能体进行观察（按其 use 选择模型）
            const reply = await Agent.get('summarize_agent').chat(prompt);
            if (!reply) return;

            // 宽容解析：模型偶尔回带代码块围栏/前后缀文本，不再因此丢失整次观察
            const memoryData = parseLooseJson(reply);
            if (!memoryData || typeof memoryData !== 'object') {
                log.warning('观察记忆：模型返回无法解析的 JSON，本次不落库');
                return;
            }

            // 防注入：观察内容可能夹带内部上下文标签，入库前统一剥离；缺失时以空串兜底
            const summaryContent = stripInternalTags(typeof memoryData.summary === 'string' ? memoryData.summary : (typeof memoryData.content === 'string' ? memoryData.content : ''));
            if (summaryContent) {
                // 写入观察记忆，供 buildObservationPrompt 使用
                this.summaries.push(summaryContent);
                this.limitSummaries();
                bumpSummaryRevision();
            }

            // 事实落库：新协议 facts 数组；兼容旧协议 memories 数组（转 add 事实）
            let facts: MemoryFact[] = [];
            if (Array.isArray(memoryData.facts)) {
                facts = memoryData.facts as MemoryFact[];
            } else if (Array.isArray(memoryData.memories)) {
                facts = (memoryData.memories as any[]).map(m => ({
                    op: 'add',
                    memory_type: m && m.memory_type,
                    target_id: m && m.target_id,
                    type: 'text',
                    text: m && typeof m.text === 'string' ? m.text : '',
                    keywords: Array.isArray(m && m.keywords) ? m.keywords : [],
                    related_user_ids: Array.isArray(m && m.related_user_ids) ? m.related_user_ids : [],
                    related_group_ids: Array.isArray(m && m.related_group_ids) ? m.related_group_ids : [],
                    visibility: m && m.visibility
                } as MemoryFact));
            }

            const touched = new Set<Session>([this.session]);
            if (facts.length > 0) {
                const sessionIsGroup = this.session.sessionType === 'group';
                let successCount = 0;
                let fallbackCount = 0;
                const skipped: string[] = [];
                for (const fact of facts) {
                    if (!fact || typeof fact !== 'object' || typeof fact.text !== 'string' || !fact.text) {
                        skipped.push('缺少 text 的事实条目');
                        continue;
                    }
                    // 归属会话解析：有 target_id 按 ID 定位；缺省时仅当前会话可作归属
                    let target: Session | null = null;
                    let fallback = false;
                    const mt = fact.memory_type;
                    if (mt === 'private') {
                        if (fact.target_id) {
                            target = resolveTargetSession(this.session, 'private', fact.target_id);
                            if (!target) { skipped.push(`用户目标ID格式无效<${fact.target_id}>`); continue; }
                        } else if (!sessionIsGroup) {
                            target = this.session;
                            fallback = true;
                        } else {
                            skipped.push('缺少 target_id，无法定位个人记忆');
                            continue;
                        }
                    } else if (mt === 'group') {
                        if (fact.target_id) {
                            target = resolveTargetSession(this.session, 'group', fact.target_id);
                            if (!target) { skipped.push(`群目标ID格式无效<${fact.target_id}>`); continue; }
                        } else if (sessionIsGroup) {
                            target = this.session;
                            fallback = true;
                        } else {
                            skipped.push('缺少 target_id，无法定位群聊记忆');
                            continue;
                        }
                    } else {
                        skipped.push(`未知 memory_type<${mt}>，按当前会话归属`);
                        fallback = true;
                        target = this.session;
                    }
                    if (!target) continue;

                    const result = await target.memory.applyFact(fact);
                    if (result.action !== 'noop') {
                        successCount++;
                        if (fallback) fallbackCount++;
                        touched.add(target);
                    }
                }
                if (skipped.length > 0) {
                    log.warning(`观察记忆：成功写入 ${successCount} 条（含 ${fallbackCount} 条当前会话归属），跳过 ${skipped.length} 条（${Array.from(new Set(skipped)).join('；')}）`);
                }
            }

            // 先持久化本轮写入的观察/事实，避免内容落盘前推进游标导致重启后跳过
            touched.forEach(s => s.save());

            // 内容已持久化后再推进增量游标；若游标保存失败，最坏情况是重复观察，不会丢失
            this.session.context.lastSummarizedIndex = end;
            this.session.save();
            // 巩固触发：每 CONSOLIDATE_INTERVAL 次观察后整合重复观察/清理过期记忆
            const { CONSOLIDATE_INTERVAL } = Config.memory;
            if (CONSOLIDATE_INTERVAL > 0) {
                this.summaryCount++;
                if (this.summaryCount >= CONSOLIDATE_INTERVAL) {
                    this.summaryCount = 0;
                    this.consolidate().catch(e => {
                        log.warning('记忆巩固失败: ' + (e instanceof Error ? e.message : String(e)));
                    });
                }
            }
        } catch (e) {
            log.exception('更新观察记忆失败', e);
        } finally {
            this.summarizing = false;
        }
    }

    /**
     * 记忆巩固：合并高度相似的观察条目；标记/清理过期记忆（stale）。
     * 由 summarize 按间隔触发或 .ai memo cons 手动触发；不阻塞对话。
     */
    async consolidate(): Promise<void> {
        if (this.consolidating) return;
        this.consolidating = true;
        try {
            // 1) 合并重复观察（保序去重，仅当确有合并时推进 revision）
            const mergedSummaries = MemoryService.mergeSimilarSummaries(this.summaries);
            const removedSummaries = this.summaries.length - mergedSummaries.length;
            if (removedSummaries > 0) {
                this.summaries = mergedSummaries;
                bumpSummaryRevision();
                log.info(`记忆巩固：观察条目 ${mergedSummaries.length} 条（去重 ${removedSummaries} 条）`);
            }
            // 2) 标记/清理 stale 记忆
            const { marked, deleted } = this.markAndPruneStale();
            if (marked > 0 || deleted.length > 0) {
                log.info(`记忆巩固：标记过期 ${marked} 条，清理 ${deleted.length} 条`);
            }
            this.session.save();
        } finally {
            this.consolidating = false;
        }
    }

    limitSummaries() {
        const { SUMMARY_LIMIT } = Config.memory;
        const limit = SUMMARY_LIMIT > 0 ? SUMMARY_LIMIT : 10;
        if (this.summaries.length > limit) this.summaries.splice(0, this.summaries.length - limit);
    }

    clearSummaries() {
        this.summaries = [];
        bumpSummaryRevision();
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
}

function toLegacyMemoryItem(unit: MemoryUnit): MemoryItem {
    const m = new MemoryItem();
    m.id = unit.id;
    m.sessionId = unit.bankId;
    m.type = unit.factType === 'observation' ? 'text' : unit.factType === 'experience' ? 'event' : 'fact';
    m.visibility = unit.tags.includes('vis:private') ? 'private' : 'public';
    m.createAt = unit.createdAt;
    m.lastAccessedAt = unit.lastAccessedAt;
    m.accessCount = unit.accessCount;
    m.importance = unit.importance;
    m.stale = unit.state !== 'valid';
    m.content = unit.text;
    m.vector = unit.embedding;
    m.tags = unit.tags;
    m.relatedMemories = [];
    m.users = unit.tags.filter(t => t.startsWith('user:')).map(t => t.slice(5));
    m.groups = unit.tags.filter(t => t.startsWith('group:')).map(t => t.slice(6));
    return m;
}

function canSeeUnit(unit: MemoryUnit, callerSessionId: string): boolean {
    const privateTags = unit.tags.filter(t => t.startsWith('vis:private:'));
    if (privateTags.length === 0) return true;
    return privateTags.some(t => t === `vis:private:${callerSessionId}`);
}






