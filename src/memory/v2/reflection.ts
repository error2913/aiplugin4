// 反思（叶子）：按问题聚合心智模型/观察/事实记忆，交给 reflectSynthesizer 生成答案（严格模式不回退原文 dump）。
// 从 memory/v2/engine.ts 拆出——只依赖 repository + recall 回调 + 可选的 reflectSynthesizer，
// engine.ts 保留 reflect() 委派与 scopeNoteForBank 逻辑（纯函数）。
import type { MemoryRepository } from "./repository";
import type {
    FactType,
    MentalModel,
    MentalModelTrigger,
    Observation,
    RecallResult,
    ReflectResult,
    ReflectSynthesizer,
} from "./types";

const NO_MEMORY_TEXT = '暂无足够记忆进行推理';

/** 反思所需的最小宿主视图（MemoryEngine 注入 recall + 合成回调） */
export interface ReflectHost {
    repository: MemoryRepository;
    reflectSynthesizer?: ReflectSynthesizer;
    recall(bankId: string, query: string, opts: Record<string, unknown>): Promise<RecallResult[]>;
}

export async function reflect(
    host: ReflectHost,
    bankId: string,
    query: string,
    opts: {
        factTypes?: FactType[];
        scopeTags?: string[];
        excludeMentalModelIds?: string[];
        createdAfter?: number;
        mode?: MentalModelTrigger;
        existingAnswer?: string;
        strict?: boolean;
        maxTokens?: number;
        scopeNote?: string;
    } = {}
): Promise<ReflectResult> {
    const bank = host.repository.getBank(bankId);
    const exclude = new Set(opts.excludeMentalModelIds || []);
    const mentalModels: MentalModel[] = (bank ? bank.mentalModels : [])
        .filter(m => !exclude.has(m.id) && (m.status === 'ready' || m.status === undefined));
    const observations: Observation[] = (bank ? bank.observations : [])
        .filter(o => {
            if (opts.scopeTags && opts.scopeTags.length) {
                const tags = o.scopeTags || [];
                if (!tags.some(t => opts.scopeTags!.includes(t))) return false;
            }
            if (opts.createdAfter && (o.updatedAt || 0) <= opts.createdAfter) return false;
            return true;
        });
    // 事实类记忆走 recall；observation 由 observations 列表单独提供，避免 unit 与 observation 双重注入
    const unitTypes = (opts.factTypes || ['world', 'experience', 'observation']).filter(t => t !== 'observation');
    const memories = (await host.recall(bankId, query, {
        types: unitTypes.length > 0 ? unitTypes : ['world', 'experience'],
        tags: opts.scopeTags || [],
        maxTokens: opts.maxTokens || 4096,
    }))
        .map(r => r.unit)
        .filter(u => !opts.createdAfter || (u.updatedAt || 0) > opts.createdAfter);
    let text = '';
    if (host.reflectSynthesizer) {
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
        if (opts.strict) {
            // 刷新路径：禁止把记忆原文/心智模型 dump 成"答案"（避免把占位文本/记忆清单写进心智模型）
            text = '';
        } else {
            text = [
                ...mentalModels.map(m => `【心智模型】${m.question}\n${m.answer}`),
                ...observations.map(o => `【观察】${o.text}`),
                ...memories.map(m => `【事实】${m.text}`),
            ].join('\n') || NO_MEMORY_TEXT;
        }
    }
    return {
        text,
        basedOn: { mentalModels, observations, memories },
    };
}

/** 由 bankId（user_/group_ 前缀 + 平台前缀 ID）生成 reflect 范围提示行 */
export function scopeNoteForBank(bankId: string): string {
    const sep = bankId.indexOf('_');
    const prefix = sep > 0 ? bankId.slice(0, sep) : '';
    const raw = sep > 0 ? bankId.slice(sep + 1) : bankId;
    const kindLabel = prefix === 'group' ? '群聊' : prefix === 'user' ? '私聊' : '会话';
    const colon = raw.indexOf(':');
    const platform = colon > 0 ? raw.slice(0, colon) : '';
    return platform
        ? `当前范围：平台=${platform}，会话=${kindLabel} ${raw}`
        : `当前范围：会话=${kindLabel} ${raw}`;
}
