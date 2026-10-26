// 默认 LLM 回调：观察决策、观察合成、reflect 合成、rerank、delta 类型化编辑。
import { getAuxLlm } from "../../core/ports/aux_llm";

import type {
    DeltaOperation,
    DeltaOperator,
    ObservationDecision,
    ObservationDecisionMaker,
    ObservationSynthesizer,
    ReflectSynthesizer,
    Reranker,
    StructuredDoc,
} from "./types";

function extractJson(text: string): any {
    if (!text) return null;
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

const OBSERVATION_DECISION_PROMPT = `你是记忆观察维护器。给定「现有观察」与「新证据」，判断如何处理：
- create：无相关观察，新建；
- reinforce：新证据支持现有观察，补充证据但不必改文本；
- refine：新证据需要更精确地重写观察；
- contradict：新证据与观察矛盾，改写为时间叙事（以前…现在…），保留旧历史；
- merge：多个观察应合并（targetId 指定保留的观察）；
- noop：证据无价值。
只输出 JSON：{"action":"create|reinforce|refine|contradict|merge|noop","targetId":"可选","text":"观察文本","evidenceMemoryIds":["id"]}`;

const OBSERVATION_SYNTH_PROMPT = `你是记忆观察合成器。根据支持证据生成一条稳定、去重、可长期使用的观察。
要求：合并重复；保留关键限定；矛盾时描述变化过程；数字/实体/否定/条件不同不要合并。
只输出 JSON：{"observation":"合成后的观察文本"}`;

const REFLECT_FULL_PROMPT = `你是基于记忆的推理助手。只依据提供的记忆回答，不足时说明缺少什么，不要编造。
回答控制在 200 字以内，直接输出答案，并尽量标注引用来源的 id。`;

const REFLECT_DELTA_PROMPT = `你是心智模型维护器。基于「当前答案」与「最近新增记忆」做增量更新：保留仍成立内容，只改被新证据影响的部分；不编造。
直接输出更新后的完整答案，控制在 200 字以内。`;

const DELTA_OPS_PROMPT = `你是结构化文档增量编辑器。给定当前文档 AST 与新增证据，输出类型化操作：
- add_section {heading, blocks}
- append_bullet {sectionId, text}
- replace_block {blockId, text}
- remove_stale_paragraph {blockId}
- replace_section_blocks {sectionId, blocks}
blocks 的每项 {"id":"可选","type":"paragraph|bullet|checklist|code","text":"..."}。
只输出 JSON：{"operations":[...]}。不要输出未受影响的 block，它们会被原样保留。`;

const RERANK_PROMPT = `你是记忆重排器。按相关性从高到低输出候选记忆 ID。
只输出 JSON：{"ranked_ids":["id1","id2"]}`;

export const defaultReranker: Reranker = async (query, candidates) => {
    try {
        const list = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join('\n');
        const reply = await getAuxLlm().chat('summarize_agent', `${RERANK_PROMPT}\n\n查询：${query}\n候选记忆：\n${list}`);
        const data = extractJson(reply);
        const ids = Array.isArray(data?.ranked_ids) ? data.ranked_ids.map(String) : [];
        const valid = ids.filter((id: string) => candidates.some(c => c.id === id));
        return valid.length ? valid : candidates.map(c => c.id);
    } catch {
        return candidates.map(c => c.id);
    }
};

export const defaultObservationSynthesizer: ObservationSynthesizer = async (quotes) => {
    try {
        const evidence = quotes.map((q, i) => `${i + 1}. ${q}`).join('\n');
        const reply = await getAuxLlm().chat('summarize_agent', `${OBSERVATION_SYNTH_PROMPT}\n\n支持证据：\n${evidence}`);
        const data = extractJson(reply);
        return typeof data?.observation === 'string' && data.observation.trim()
            ? data.observation.trim()
            : quotes.join('；');
    } catch {
        return quotes.join('；');
    }
};

export const defaultObservationDecisionMaker: ObservationDecisionMaker = async ({ evidence, existing, tags }) => {
    try {
        const existingText = existing.length
            ? existing.map(o => `[${o.id}] ${o.text}（证据 ${o.proofCount} 条）`).join('\n')
            : '（无）';
        const reply = await getAuxLlm().chat('summarize_agent',
            `${OBSERVATION_DECISION_PROMPT}\n\n范围标签：${tags.join(',') || '无'}\n现有观察：\n${existingText}\n\n新证据：\n${evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
        );
        const data = extractJson(reply);
        const action = data?.action;
        if (['create', 'reinforce', 'refine', 'contradict', 'merge', 'noop'].includes(action)) {
            return {
                action,
                targetId: typeof data.targetId === 'string' ? data.targetId : undefined,
                text: typeof data.text === 'string' ? data.text : undefined,
                evidenceMemoryIds: Array.isArray(data.evidenceMemoryIds) ? data.evidenceMemoryIds.map(String) : undefined,
            } as ObservationDecision;
        }
        return { action: 'create' } as ObservationDecision;
    } catch {
        return { action: 'create' } as ObservationDecision;
    }
};

export const defaultDeltaOperator: DeltaOperator = async ({ sourceQuery, structured, evidence }) => {
    try {
        const reply = await getAuxLlm().chat('summarize_agent',
            `${DELTA_OPS_PROMPT}\n\n主题：${sourceQuery}\n当前文档 AST：\n${JSON.stringify(structured)}\n新增证据：\n${evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
        );
        const data = extractJson(reply);
        const ops = Array.isArray(data?.operations) ? data.operations : [];
        return ops.filter((op: any) => op && typeof op.op === 'string') as DeltaOperation[];
    } catch {
        return [];
    }
};

export const defaultReflectSynthesizer: ReflectSynthesizer = async (query, context) => {
    try {
        const parts: string[] = [];
        if (context.mentalModels.length) {
            parts.push('【心智模型】');
            parts.push(context.mentalModels.map(m => `- [${m.id}] ${m.sourceQuery}\n  ${m.content}`).join('\n'));
        }
        if (context.observations.length) {
            parts.push('【观察】');
            parts.push(context.observations.map(o => `- [${o.id}] ${o.text}`).join('\n'));
        }
        if (context.memories.length) {
            parts.push('【事实】');
            parts.push(context.memories.map(m => `- [${m.id}] ${m.text}`).join('\n'));
        }
        const isDelta = context.mode === 'delta' && !!context.existingAnswer;
        const prompt = isDelta ? REFLECT_DELTA_PROMPT : REFLECT_FULL_PROMPT;
        const scopeLine = context.scopeNote ? `${context.scopeNote}\n\n` : '';
        const input = isDelta
            ? `当前答案：\n${context.existingAnswer}\n\n最近新增的相关记忆：\n${parts.join('\n\n') || '（无）'}`
            : `问题：${query}\n相关记忆：\n${parts.join('\n\n') || '（无）'}`;
        const reply = await getAuxLlm().chat('summarize_agent', `${scopeLine}${prompt}\n\n${input}`);
        return (reply || '').trim();
    } catch {
        return '';
    }
};

export function configureDefaultCallbacks(engine: {
    setReranker(rerank: Reranker): void;
    setObservationSynthesizer(synth: ObservationSynthesizer): void;
    setObservationDecision(decider: ObservationDecisionMaker): void;
    setReflectSynthesizer(synth: ReflectSynthesizer): void;
    setDeltaOps(ops: DeltaOperator): void;
}): void {
    engine.setReranker(defaultReranker);
    engine.setObservationSynthesizer(defaultObservationSynthesizer);
    engine.setObservationDecision(defaultObservationDecisionMaker);
    engine.setReflectSynthesizer(defaultReflectSynthesizer);
    engine.setDeltaOps(defaultDeltaOperator);
}

export type { StructuredDoc };
