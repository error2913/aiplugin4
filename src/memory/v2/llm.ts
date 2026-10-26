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

const OBSERVATION_DECISION_PROMPT = `You maintain memory observations. Given the "existing observations" and "new evidence", decide how to handle it:
- create: no related observation exists; create one;
- reinforce: the new evidence supports an existing observation; add evidence without rewriting the text;
- refine: the new evidence requires rewriting the observation more precisely;
- contradict: the new evidence contradicts the observation; rewrite it as a temporal narrative (previously ... now ...) while keeping the old history;
- merge: several observations should be merged (targetId names the observation to keep);
- noop: the evidence is not valuable.
Write all generated text in the language of the conversation.
Output only JSON: {"action":"create|reinforce|refine|contradict|merge|noop","targetId":"optional","text":"observation text","evidenceMemoryIds":["id"]}`;

const OBSERVATION_SYNTH_PROMPT = `You are a memory observation synthesizer. Produce one stable, deduplicated, long-lived observation from the supporting evidence.
Requirements: merge duplicates; keep the key qualifiers; describe the change process when evidence conflicts; do not merge when numbers, entities, negations or conditions differ.
Write all generated text in the language of the conversation.
Output only JSON: {"observation":"synthesized observation text"}`;

const REFLECT_FULL_PROMPT = `You are a memory-based reasoning assistant. Answer using only the provided memories; when they are insufficient, state what is missing instead of making things up.
Keep the answer short (about 200 characters), output the answer directly, and cite the ids of sources where possible.
Write all generated text in the language of the conversation.`;

const REFLECT_DELTA_PROMPT = `You maintain mental models. Incrementally update the "current answer" with the "recently added memories": keep what still holds and change only the parts affected by the new evidence; do not make things up.
Output the full updated answer directly and keep it short (about 200 characters).
Write all generated text in the language of the conversation.`;

const DELTA_OPS_PROMPT = `You are an incremental editor for structured documents. Given the current document AST and new evidence, output typed operations:
- add_section {heading, blocks}
- append_bullet {sectionId, text}
- replace_block {blockId, text}
- remove_stale_paragraph {blockId}
- replace_section_blocks {sectionId, blocks}
Each item of blocks is {"id":"optional","type":"paragraph|bullet|checklist|code","text":"..."}.
Write all generated text in the language of the conversation.
Output only JSON: {"operations":[...]}. Do not output unaffected blocks; they are preserved as-is.`;

const RERANK_PROMPT = `You are a memory re-ranker. Output the candidate memory IDs from most to least relevant.
Output only JSON: {"ranked_ids":["id1","id2"]}`;

export const defaultReranker: Reranker = async (query, candidates) => {
    try {
        const list = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join('\n');
        const reply = await getAuxLlm().chat('summarize_agent', `${RERANK_PROMPT}\n\nQuery: ${query}\nCandidate memories:\n${list}`);
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
        const reply = await getAuxLlm().chat('summarize_agent', `${OBSERVATION_SYNTH_PROMPT}\n\nSupporting evidence:\n${evidence}`);
        const data = extractJson(reply);
        return typeof data?.observation === 'string' && data.observation.trim()
            ? data.observation.trim()
            : quotes.join('; ');
    } catch {
        return quotes.join('; ');
    }
};

export const defaultObservationDecisionMaker: ObservationDecisionMaker = async ({ evidence, existing, tags }) => {
    try {
        const existingText = existing.length
            ? existing.map(o => `[${o.id}] ${o.text} (${o.proofCount} evidence items)`).join('\n')
            : '(none)';
        const reply = await getAuxLlm().chat('summarize_agent',
            `${OBSERVATION_DECISION_PROMPT}\n\nScope tags: ${tags.join(',') || 'none'}\nExisting observations:\n${existingText}\n\nNew evidence:\n${evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
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
            `${DELTA_OPS_PROMPT}\n\nTopic: ${sourceQuery}\nCurrent document AST:\n${JSON.stringify(structured)}\nNew evidence:\n${evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
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
            parts.push('Mental models:');
            parts.push(context.mentalModels.map(m => `- [${m.id}] ${m.sourceQuery}\n  ${m.content}`).join('\n'));
        }
        if (context.observations.length) {
            parts.push('Observations:');
            parts.push(context.observations.map(o => `- [${o.id}] ${o.text}`).join('\n'));
        }
        if (context.memories.length) {
            parts.push('Facts:');
            parts.push(context.memories.map(m => `- [${m.id}] ${m.text}`).join('\n'));
        }
        const isDelta = context.mode === 'delta' && !!context.existingAnswer;
        const prompt = isDelta ? REFLECT_DELTA_PROMPT : REFLECT_FULL_PROMPT;
        const scopeLine = context.scopeNote ? `${context.scopeNote}\n\n` : '';
        const input = isDelta
            ? `Current answer:\n${context.existingAnswer}\n\nRecently added relevant memories:\n${parts.join('\n\n') || '(none)'}`
            : `Question: ${query}\nRelated memories:\n${parts.join('\n\n') || '(none)'}`;
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
