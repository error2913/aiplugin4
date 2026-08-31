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
        .filter(m => scopeMatch(m.scopeTags))
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
    mentalModels?: MentalModel[];
    observations?: Observation[];
    recalls?: RecallResult[];
    maxLengthPerItem?: number;
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
 * 分组渲染记忆段：按「群聊 / 每个发言者」分别渲染长期记忆 + 心智模型，
 * 避免多个归属的心智模型/记忆混在同一段里造成归属混淆。
 */
export function buildGroupedMemoryPrompt(sections: MemoryPromptSection[]): string {
    const parts: string[] = [];
    for (const sec of sections) {
        const hasMM = !!sec.mentalModels?.length;
        const hasObs = !!sec.observations?.length;
        const hasRecall = !!sec.recalls?.length;
        if (!hasMM && !hasObs && !hasRecall) continue;
        const max = sec.maxLengthPerItem ?? 1000;
        const lines: string[] = [`## ${sec.title}`];
        if (hasMM) {
            lines.push('心智模型：');
            lines.push(sec.mentalModels!.map(m => `${m.question}\n${truncate(m.answer, max)}`).join('\n'));
        }
        if (hasObs) {
            lines.push('观察记忆：');
            lines.push(sec.observations!.map((o, i) => `${i + 1}. ${truncate(o.text, max)}`).join('\n'));
        }
        if (hasRecall) {
            lines.push('长期记忆：');
            lines.push(sec.recalls!.map((r, i) => `${i + 1}. [${r.unit.id}] ${truncate(r.unit.text, max)}`).join('\n'));
        }
        parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
}

function truncate(text: string, max: number): string {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}

