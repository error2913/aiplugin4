// 会话记忆：总结记忆（调用摘要智能体）、事实落库、巩固与记忆 prompt 构建
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { SUMMARY_PROMPT_TEMPLATE, SUMMARY_TEMPLATE } from "../prompt/templates";
import Group from "../session/group";
import { Session } from "../session/session";
import User from "../session/user";
import { buildContent } from "../utils/message";
import { stripInternalTags, truncateText } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";

import MemoryService from "./memory";
import MemoryItem from "./memory_item";
import { bumpSummaryRevision } from "./revision";
import { resolveTargetSession } from "./session_target";
import { MemoryFact } from "./types";

const log = Logger.withTag('memory');

const MEMORY_RENDER_LIMIT = 1000;

/**
 * 宽容 JSON 解析：剥离 ```json 围栏、容忍前后缀文本、截取首个 {...}。
 * 解析失败返回 null（调用方降级处理，不再因模型格式问题丢失整次总结）。
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
        summaries: { array: 'string' },
        // 旧版本「短期记忆」字段：仅用于存档加载与迁移，新代码不再读写
        useShortMemory: 'boolean',
        shortMemoryList: { array: 'string' },
        persona: 'string'
    };
    agentName: string;
    sessionId: string;
    summaryStatus: boolean;
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
        this.summaries = [];
        this.summarizing = false;
        this.consolidating = false;
        this.summaryCount = 0;
    }

    get agent(): Agent { return Agent.get(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }

    /** 旧存档迁移：历史「短期记忆」与「总结记忆」内容相同，统一并入总结记忆；开关合并到 summaryStatus */
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
    }

    // 总结记忆（每轮对话后由 context.addAssistantMessage 触发；增量：只总结上次游标之后的消息）
    async summarize() {
        // 开关：全局「启用总结记忆」或会话级 summaryStatus（含旧存档迁移）任一开启即生效
        if (!this.summaryStatus && !Config.memory.SUMMARY) return;
        if (this.summarizing) return; // 重入保护
        this.summarizing = true;
        try {
            const { SUMMARY_SIZE } = Config.memory;
            const messages = this.session.context.messages;
            // 增量游标：上次总结位置；上下文被裁剪（limitMessages）导致游标越界时回退到 0 重新总结
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

            log.info('记忆总结prompt:\n', prompt);

            // 使用摘要智能体进行总结（按其 use 选择模型）
            const reply = await Agent.get('summarize_agent').chat(prompt);
            if (!reply) return;

            // 宽容解析：模型偶尔回带代码块围栏/前后缀文本，不再因此丢失整次总结
            const memoryData = parseLooseJson(reply);
            if (!memoryData || typeof memoryData !== 'object') {
                log.warning('总结记忆：模型返回无法解析的 JSON，本次不落库');
                return;
            }

            // 防注入：总结内容可能夹带内部上下文标签，入库前统一剥离；缺失时以空串兜底
            const summaryContent = stripInternalTags(typeof memoryData.content === 'string' ? memoryData.content : '');
            if (summaryContent) {
                // 写入总结记忆，供 buildSummaryPrompt 使用
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
                    log.warning(`总结记忆：成功写入 ${successCount} 条（含 ${fallbackCount} 条当前会话归属），跳过 ${skipped.length} 条（${Array.from(new Set(skipped)).join('；')}）`);
                }
            }

            // 推进增量游标：只总结成功推进，失败下次重试
            this.session.context.lastSummarizedIndex = end;

            // 持久化：总结写入的每个会话（含目标会话）显式保存，防止重启丢失
            touched.forEach(s => s.save());

            // 巩固触发：每 CONSOLIDATE_INTERVAL 次总结后整合重复总结/清理过期记忆
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
            log.exception('更新总结记忆失败', e);
        } finally {
            this.summarizing = false;
        }
    }

    /**
     * 记忆巩固：合并高度相似的总结条目；标记/清理过期记忆（stale）。
     * 由 summarize 按间隔触发或 .ai memo cons 手动触发；不阻塞对话。
     */
    async consolidate(): Promise<void> {
        if (this.consolidating) return;
        this.consolidating = true;
        try {
            // 1) 合并重复总结（保序去重，仅当确有合并时推进 revision）
            const mergedSummaries = MemoryService.mergeSimilarSummaries(this.summaries);
            const removedSummaries = this.summaries.length - mergedSummaries.length;
            if (removedSummaries > 0) {
                this.summaries = mergedSummaries;
                bumpSummaryRevision();
                log.info(`记忆巩固：总结条目 ${mergedSummaries.length} 条（去重 ${removedSummaries} 条）`);
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

    buildSummaryPrompt(): string {
        if (this.summaries.length === 0) return '';
        const { SUMMARY } = Config.memory;
        return SUMMARY_TEMPLATE({
            "SUMMARY": SUMMARY,
            "summaries": this.summaries.map(summary => truncateText(summary, MEMORY_RENDER_LIMIT))
        });
    }
}
