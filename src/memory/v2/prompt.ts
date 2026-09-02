// 记忆 Prompt 渲染：MentalModel + Observation + Recall 结果。
import type { MentalModel, Observation, RecallResult } from "./types";

/** 观察记忆过期窗口（天）：lastVerifiedAt 距今超过该值视为 STALE，注入时剔除 */
export const OBSERVATION_STALE_DAYS = 90;
/** 注入心智模型条数上限 */
export const MAX_MENTAL_MODELS = 5;
/** 注入观察记忆条数上限 */
export const MAX_OBSERVATIONS = 20;

export interface InjectionCandidates {
    mentalModels: MentalModel[];
    observations: Observation[];
}

/**
 * 心智模型注入合并：固定模板在前、语义召回补余，按 limit 截断并去重（同 id 只取第一次出现）。
 * 固定/语义列表需已按各自排序（模板目录顺序 / 相关度降序）。
 */
export function mergeMentalModels(fixed: MentalModel[], ranked: MentalModel[], limit: number): MentalModel[] {
    const out: MentalModel[] = [];
    const seen = new Set<string>();
    for (const m of [...fixed, ...ranked]) {
        if (out.length >= limit) break;
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
    }
    return out;
}

/**
 * 注入候选筛选（E1/E2）：
 * - scopeTags 过滤：任一命中即注入（空 scopeTags 视为全局放行），
 *   避免 all_strict 下群聊中「未在最近消息出现的贡献者」导致整条被剔除
 * - stale 剔除：观察记忆按 lastVerifiedAt 过期窗口过滤
 * - 条数上限：心智模型 MAX_MENTAL_MODELS、观察 MAX_OBSERVATIONS，按更新时间倒序取最新
 */
export function selectInjectionCandidates(
    mentalModels: MentalModel[],
    observations: Observation[],
    sessionTags: string[],
    now: number = Date.now()
): InjectionCandidates {
    const tagSet = new Set(sessionTags);
    const scopeMatch = (scope: string[] | undefined): boolean => {
        const tags = scope || [];
        if (tags.length === 0) return true;
        return tags.some(t => tagSet.has(t));
    };
    const staleCutoff = Math.floor(now / 1000) - OBSERVATION_STALE_DAYS * 86400;
    const fresh = (observations || [])
        .filter(o => (o.lastVerifiedAt ?? o.updatedAt ?? 0) >= staleCutoff && scopeMatch(o.scopeTags))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_OBSERVATIONS);
    const mms = (mentalModels || [])
        // 只注入可用（ready）心智模型：pending=占位待生成、failed=上次失败，均不注入占位/过期文本
        .filter(m => (m.status === 'ready' || m.status === undefined) && scopeMatch(m.scopeTags))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, MAX_MENTAL_MODELS);
    return { mentalModels: mms, observations: fresh };
}

export interface MemoryPromptOptions {
    isPrivate: boolean;
    sessionName: string;
    mentalModels?: MentalModel[];
    observations?: Observation[];
    recalls?: RecallResult[];
    maxLengthPerItem?: number;
}

/** 分组记忆段：一组对应一个归属（群聊 / 某个发言者），组内独立渲染心智模型 + 观察记忆 + 长期记忆 */
export interface MemoryPromptSection {
    title: string;
    /** 会话身份行（如 群聊：QQ-Group:xxx（群名）/ 个人：QQ:xxx（名字）），渲染到该段头部 */
    scopeLabel?: string;
    mentalModels?: MentalModel[];
    observations?: Observation[];
    recalls?: RecallResult[];
    maxLengthPerItem?: number;
}


export function buildMentalModelsPrompt(mentalModels: MentalModel[] | undefined, max = 1000): string {
    const ready = (mentalModels || []).filter(m => m.status === 'ready' || m.status === undefined);
    if (ready.length === 0) return '';
    const lines = ['## 心智模型'];
    for (const m of ready) {
        lines.push(`${m.question}\n${truncate(m.answer, max)}`);
    }
    return lines.join('\n');
}

export function buildLongTermMemoryPrompt(
    recalls: RecallResult[] | undefined,
    isPrivate: boolean,
    sessionName: string,
    max = 1000
): string {
    if (!recalls?.length) return '';
    const head = isPrivate ? '记忆类型:个人记忆' : `记忆类型:群聊记忆\n群聊名称:${sessionName}`;
    const list = recalls.map((r, i) => `${i + 1}. [${r.unit.id}] ${truncate(r.unit.text, max)}`).join('\n');
    return `## 长期记忆\n${head}\n记忆列表:\n${list}`;
}

export function buildMemoryPrompt(options: MemoryPromptOptions): string {
    const parts: string[] = [];
    const max = options.maxLengthPerItem ?? 1000;

    if (options.mentalModels?.length) {
        parts.push('## 心智模型');
        parts.push(options.mentalModels.map(m => `${m.question}\n${truncate(m.answer, max)}`).join('\n'));
    }

    if (options.observations?.length) {
        parts.push('## 观察记忆');
        parts.push(options.observations.map((o, i) => `${i + 1}. ${truncate(o.text, max)}`).join('\n'));
    }

    if (options.recalls?.length) {
        const memoryType = options.isPrivate ? '个人记忆' : '群聊记忆';
        const head = `记忆类型:${memoryType}`;
        const nameLine = options.isPrivate ? '' : `\n群聊名称:${options.sessionName}`;
        const list = options.recalls.map((r, i) => `${i + 1}. [${r.unit.id}] ${truncate(r.unit.text, max)}`).join('\n');
        parts.push(`## 长期记忆\n${head}${nameLine}\n记忆列表:\n${list}`);
    }

    return parts.join('\n\n');
}

/**
 * 分组渲染记忆段：群聊拆分为「群聊心智模型 / 群聊长期记忆 / 个人记忆」，
 * 私聊拆分为「心智模型 / 长期记忆」。
 * 观察记忆由独立的 buildObservationPrompt 注入，不再出现在长期记忆分组中。
 */
export function buildGroupedMemoryPrompt(sections: MemoryPromptSection[]): string {
    const parts: string[] = [];

    for (const sec of sections) {
        const hasMM = !!sec.mentalModels?.length;
        const hasRecall = !!sec.recalls?.length;
        if (!hasMM && !hasRecall) continue;
        const max = sec.maxLengthPerItem ?? 1000;

        const isGroupLevel = sec.title.startsWith('群聊');
        if (isGroupLevel) {
            const block: string[] = [];
            if (sec.scopeLabel) block.push(sec.scopeLabel);
            block.push('当前回答范围：仅该群记忆；提到其他群的记录只算背景，不算该群设定');
            if (hasMM) {
                block.push('');
                block.push(buildMentalModelsPrompt(sec.mentalModels, max).replace('## 心智模型', '## 群聊心智模型'));
            }
            if (hasRecall) {
                block.push('');
                block.push(buildLongTermMemoryPrompt(sec.recalls, false, sec.title.replace(/^群聊记忆（|）$/g, ''), max)
                    .replace('## 长期记忆', '## 群聊长期记忆'));
            }
            parts.push(block.join('\n'));
        } else {
            const lines: string[] = [`## ${sec.title}`];
            if (sec.scopeLabel) lines.push(sec.scopeLabel);
            lines.push('本段仅用于理解该发言者，不作为“群设定/群规则”的依据');
            if (hasMM) {
                lines.push('心智模型：');
                lines.push(sec.mentalModels!.map(m => `${m.question}\n${truncate(m.answer, max)}`).join('\n'));
            }
            if (hasRecall) {
                lines.push('长期记忆：');
                lines.push(sec.recalls!.map((r, i) => `${i + 1}. [${r.unit.id}] ${truncate(r.unit.text, max)}`).join('\n'));
            }
            parts.push(lines.join('\n'));
        }
    }

    return parts.filter(Boolean).join('\n\n');
}


function truncate(text: string, max: number): string {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}

