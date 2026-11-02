// 默认 LLM 回调：观察决策（单条/批量）、观察合成、reflect 合成、rerank、delta 类型化编辑。
//
// 错误处理约定（P0-2）：
// - 所有 aux 调用都传 `throwClassified: true`，让模型分类错误（ApiError）穿透到调用方；
// - 本文件的 `catch` 只兜「非分类错误」（JSON 坏、无模型等），分类错误一律 rethrow，
//   由 memory_scheduler 做 fatal 熔断 / retry 退避。
import { getAuxLlm } from "../../core/ports/aux_llm";
import { isClassifiedApiError } from "../../model/api_error";
import { parseJsonLoose } from "../../utils/json";

import type {
    DeltaOperation,
    DeltaOperator,
    ObservationDecision,
    ObservationDecisionBatchMaker,
    ObservationDecisionMaker,
    ObservationSynthesizer,
    ReflectSynthesizer,
    Reranker,
    StructuredDoc,
} from "./types";

function auxChat(prompt: string): Promise<string> {
    return getAuxLlm().chat('summarize_agent', prompt, { throwClassified: true });
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

const OBSERVATION_BATCH_DECISION_PROMPT = `You maintain memory observations. You receive N independent items. For each item decide:
create / reinforce / refine / contradict / merge / noop (same semantics as single-item mode).
Output only JSON, one entry per item, in the same order, never omit an item:
{"decisions":[{"cluster":1,"action":"create","targetId":"optional","text":"observation text","evidenceMemoryIds":["id"]}]}
Rules:
- "cluster" is the 1-based index of the item;
- targetId must be one of that item's "Existing observations" ids, otherwise omit it;
- evidenceMemoryIds must only contain ids of that item's new evidence;
- an item's decision must never reference another item's evidence or observations;
- write observation text in the language of the conversation.`;

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

/** 单条决策原始字段归一（cluster 级校验在 consolidation.resolveDecision 里做） */
function normalizeRawDecision(raw: any): ObservationDecision | null {
    const action = raw?.action;
    if (!['create', 'reinforce', 'refine', 'contradict', 'merge', 'noop'].includes(action)) return null;
    return {
        action,
        targetId: typeof raw.targetId === 'string' ? raw.targetId : undefined,
        text: typeof raw.text === 'string' ? raw.text : undefined,
        evidenceMemoryIds: Array.isArray(raw.evidenceMemoryIds) ? raw.evidenceMemoryIds.map(String) : undefined,
    } as ObservationDecision;
}

export const defaultReranker: Reranker = async (query, candidates) => {
    try {
        const list = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join('\n');
        const reply = await auxChat(`${RERANK_PROMPT}\n\nQuery: ${query}\nCandidate memories:\n${list}`);
        const data = parseJsonLoose(reply);
        const ids = Array.isArray(data?.ranked_ids) ? data.ranked_ids.map(String) : [];
        const valid = ids.filter((id: string) => candidates.some(c => c.id === id));
        return valid.length ? valid : candidates.map(c => c.id);
    } catch (e) {
        if (isClassifiedApiError(e)) throw e;
        return candidates.map(c => c.id);
    }
};

export const defaultObservationSynthesizer: ObservationSynthesizer = async (quotes) => {
    try {
        const evidence = quotes.map((q, i) => `${i + 1}. ${q}`).join('\n');
        const reply = await auxChat(`${OBSERVATION_SYNTH_PROMPT}\n\nSupporting evidence:\n${evidence}`);
        const data = parseJsonLoose(reply);
        return typeof data?.observation === 'string' && data.observation.trim()
            ? data.observation.trim()
            : quotes.join('; ');
    } catch (e) {
        if (isClassifiedApiError(e)) throw e;
        return quotes.join('; ');
    }
};

export const defaultObservationDecisionMaker: ObservationDecisionMaker = async ({ evidence, existing, tags }) => {
    try {
        const existingText = existing.length
            ? existing.map(o => `[${o.id}] ${o.text} (${o.proofCount} evidence items)`).join('\n')
            : '(none)';
        const reply = await auxChat(
            `${OBSERVATION_DECISION_PROMPT}\n\nScope tags: ${tags.join(',') || 'none'}\nExisting observations:\n${existingText}\n\nNew evidence:\n${evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
        );
        return normalizeRawDecision(parseJsonLoose(reply)) ?? { action: 'create' } as ObservationDecision;
    } catch (e) {
        if (isClassifiedApiError(e)) throw e;
        return { action: 'create' } as ObservationDecision;
    }
};

export const defaultObservationBatchDecisionMaker: ObservationDecisionBatchMaker = async (items) => {
    try {
        const body = items.map((item, i) => {
            const existingText = item.existing.length
                ? item.existing.map(o => `[${o.id}] ${o.text} (${o.proofCount} evidence items)`).join('\n')
                : '(none)';
            return [
                `Item ${i + 1}`,
                `Scope tags: ${item.tags.join(',') || 'none'}`,
                `Existing observations:\n${existingText}`,
                `New evidence:\n${item.evidence.map((e, j) => `${j + 1}. ${e}`).join('\n')}`,
            ].join('\n');
        }).join('\n\n');
        const reply = await auxChat(`${OBSERVATION_BATCH_DECISION_PROMPT}\n\n${body}`);
        const data = parseJsonLoose(reply);
        const list: any[] = Array.isArray(data?.decisions) ? data.decisions : (Array.isArray(data) ? data : []);
        const out: Array<ObservationDecision | null> = items.map(() => null);
        for (let i = 0; i < list.length; i++) {
            const raw = list[i];
            const idx = Number.isInteger(raw?.cluster) ? Number(raw.cluster) - 1 : i;
            if (idx < 0 || idx >= items.length || out[idx]) continue;
            out[idx] = normalizeRawDecision(raw);
        }
        return out;
    } catch (e) {
        if (isClassifiedApiError(e)) throw e;
        return items.map(() => null);
    }
};

export const defaultDeltaOperator: DeltaOperator = async ({ sourceQuery, structured, evidence }) => {
    try {
        const reply = await auxChat(
            `${DELTA_OPS_PROMPT}\n\nTopic: ${sourceQuery}\nCurrent document AST:\n${JSON.stringify(structured)}\nNew evidence:\n${evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
        );
        const data = parseJsonLoose(reply);
        const ops = Array.isArray(data?.operations) ? data.operations : [];
        return ops.filter((op: any) => op && typeof op.op === 'string') as DeltaOperation[];
    } catch (e) {
        if (isClassifiedApiError(e)) throw e;
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
        const reply = await auxChat(`${scopeLine}${prompt}\n\n${input}`);
        return (reply || '').trim();
    } catch (e) {
        if (isClassifiedApiError(e)) throw e;
        return '';
    }
};

export type { StructuredDoc };
