// 反思（reflect）：心智模型优先 → 观察 → 原始事实；新鲜模型快路径 0 LLM。
import type { MemoryRepository } from "./repository";
import type {
    FactType,
    MemoryUnit,
    MentalModel,
    MentalModelTrigger,
    Observation,
    RecallHit,
    ReflectResult,
    ReflectSynthesizer,
} from "./types";

const NO_MEMORY_TEXT = 'Not enough memory to reason from yet';
const FAST_PATH_SCORE = 0.5;

export interface ReflectHost {
    repository: MemoryRepository;
    reflectSynthesizer?: ReflectSynthesizer;
    recall(bankId: string, query: string, opts: Record<string, unknown>): Promise<RecallHit[]>;
    searchModels(bankId: string, query: string, tags: string[]): Array<{ model: MentalModel; score: number; stale: boolean }>;
}

export async function reflect(
    host: ReflectHost,
    bankId: string,
    query: string,
    opts: {
        factTypes?: FactType[];
        scopeTags?: string[];
        excludeMentalModelIds?: string[];
        createdAfterSeq?: number;
        mode?: MentalModelTrigger;
        existingAnswer?: string;
        strict?: boolean;
        maxTokens?: number;
        scopeNote?: string;
        fastPath?: boolean;
    } = {},
): Promise<ReflectResult> {
    const bank = host.repository.getBank(bankId);
    const exclude = new Set(opts.excludeMentalModelIds || []);
    const tags = opts.scopeTags || [];
    const scoredModels = host.searchModels(bankId, query, tags)
        .filter(x => !exclude.has(x.model.id));
    const mentalModels = scoredModels.map(x => x.model);

    // 快路径：相关且新鲜的心智模型直接回答，0 次合成 LLM
    if (opts.fastPath !== false) {
        const best = scoredModels.find(x => x.score >= FAST_PATH_SCORE && !x.stale);
        if (best) {
            return {
                text: best.model.content,
                basedOn: { mentalModels: [best.model], observations: [], memories: [] },
                answeredBy: 'model',
            };
        }
    }

    const observations: Observation[] = (bank?.observations || []).filter(o => {
        if (o.status !== 'active') return false;
        if (tags.length && !o.tags.some(t => tags.includes(t))) return false;
        return true;
    });
    const hits = await host.recall(bankId, query, {
        tags,
        types: opts.factTypes || ['world', 'experience'],
        maxTokens: opts.maxTokens || 2048,
        createdAfterSeq: opts.createdAfterSeq,
        includeInvalidated: false,
    });
    // reflect 的“问题”通常不是检索关键词：无命中时回退到范围/时间/重要性候选，而不是空推理
    if (!hits.length && query) {
        const fallback = await host.recall(bankId, '', {
            tags,
            types: opts.factTypes || ['world', 'experience'],
            maxTokens: opts.maxTokens || 2048,
            createdAfterSeq: opts.createdAfterSeq,
            includeInvalidated: false,
        });
        hits.push(...fallback);
    }
    const memories = hits.filter(h => h.kind === 'fact' && h.unit).map(h => h.unit as MemoryUnit);

    const hasEvidence = mentalModels.length > 0 || observations.length > 0 || memories.length > 0;
    let text = '';
    if (host.reflectSynthesizer && hasEvidence) {
        try {
            text = (await host.reflectSynthesizer(query, {
                mentalModels,
                observations,
                memories,
                existingAnswer: opts.existingAnswer,
                mode: opts.mode,
                scopeNote: opts.scopeNote || scopeNoteForBank(bankId),
            })) || '';
        } catch {
            text = '';
        }
    }
    if (!text.trim()) {
        if (opts.strict) text = '';
        else if (hasEvidence) {
            text = [
                ...mentalModels.map(m => `Mental model: ${m.sourceQuery}\n${m.content}`),
                ...observations.map(o => `Observation: ${o.text}`),
                ...memories.map(m => `Fact: ${m.text}`),
            ].join('\n');
        } else {
            text = NO_MEMORY_TEXT;
        }
    }
    return {
        text,
        basedOn: { mentalModels, observations, memories },
        answeredBy: text && hasEvidence ? 'synthesis' : 'none',
    };
}

/** 由 bankId 生成 reflect 范围提示行。 */
export function scopeNoteForBank(bankId: string): string {
    const sep = bankId.indexOf('_');
    const prefix = sep > 0 ? bankId.slice(0, sep) : '';
    const raw = sep > 0 ? bankId.slice(sep + 1) : bankId;
    const kindLabel = prefix === 'group' ? 'group' : prefix === 'user' ? 'private' : 'conversation';
    const colon = raw.indexOf(':');
    const platform = colon > 0 ? raw.slice(0, colon) : '';
    return platform
        ? `Current scope: platform=${platform}, conversation=${kindLabel} ${raw}`
        : `Current scope: conversation=${kindLabel} ${raw}`;
}
