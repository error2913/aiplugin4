// 默认 LLM 回调：把 Hindsight-like 引擎的可插拔接口接到现有 summarize_agent / chat 模型。
import Agent from "../../agent/agent";

import type {
    ExtractedFact,
    FactExtractor,
    ObservationSynthesizer,
    Reranker,
    RetainInput,
} from "./types";

const EXTRACT_PROMPT = `你是一个记忆抽取器。请从用户输入中抽取值得长期记住的原子事实。

要求：
- 每条事实一句话，简洁明确；
- 识别人名、组织、地点、产品等实体；
- 如果是事件，尽量给出时间；
- 只输出 JSON，不要输出解释。

输出格式：
{
  "facts": [
    {
      "text": "原子事实",
      "entities": ["实体1", "实体2"],
      "fact_type": "world" | "experience",
      "importance": 0.0-1.0
    }
  ]
}`;

const RERANK_PROMPT = `你是一个记忆重排器。给定用户查询和若干候选记忆，请按相关性从高到低输出候选记忆 ID 列表。

只输出 JSON：
{
  "ranked_ids": ["id1", "id2", "id3"]
}`;

const OBSERVATION_PROMPT = `你是一个记忆观察合成器。根据以下支持证据，生成一条稳定、去重、可长期使用的观察记忆。

要求：
- 合并重复信息；
- 保留关键限定；
- 如果证据存在矛盾，描述变化过程；
- 只输出 JSON：
{
  "observation": "合成后的观察文本"
}`;

function parseLooseJson(text: string): any {
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
    } catch {
        return null;
    }
}

function fallbackExtract(input: RetainInput): ExtractedFact[] {
    return [{
        text: input.content,
        entities: input.entities || [],
        factType: input.factType || 'world',
        importance: input.importance ?? 0.5,
    }];
}

export const defaultFactExtractor: FactExtractor = async (input) => {
    try {
        const reply = await Agent.get('summarize_agent').chat(
            `${EXTRACT_PROMPT}\n\n输入内容：\n${input.content}`
        );
        const data = parseLooseJson(reply);
        if (!data || !Array.isArray(data.facts)) return fallbackExtract(input);
        return data.facts
            .filter((f: any) => f && typeof f.text === 'string' && f.text.trim())
            .map((f: any) => ({
                text: String(f.text).trim(),
                entities: Array.isArray(f.entities) ? f.entities.map(String) : undefined,
                factType: f.fact_type === 'experience' ? 'experience' : 'world',
                importance: typeof f.importance === 'number' ? f.importance : 0.5,
            }));
    } catch {
        return fallbackExtract(input);
    }
};

export const defaultReranker: Reranker = async (query, candidates) => {
    try {
        const list = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join('\n');
        const reply = await Agent.get('summarize_agent').chat(
            `${RERANK_PROMPT}\n\n查询：${query}\n候选记忆：\n${list}`
        );
        const data = parseLooseJson(reply);
        const rankedIds = Array.isArray(data?.ranked_ids) ? data.ranked_ids.map(String) : [];
        const valid = rankedIds.filter(id => candidates.some(c => c.id === id));
        if (valid.length > 0) return valid;
        return candidates.map(c => c.id);
    } catch {
        return candidates.map(c => c.id);
    }
};

export const defaultObservationSynthesizer: ObservationSynthesizer = async (quotes) => {
    try {
        const evidence = quotes.map((q, i) => `${i + 1}. ${q}`).join('\n');
        const reply = await Agent.get('summarize_agent').chat(
            `${OBSERVATION_PROMPT}\n\n支持证据：\n${evidence}`
        );
        const data = parseLooseJson(reply);
        const text = data?.observation;
        if (typeof text === 'string' && text.trim()) return text.trim();
        return quotes.join('；');
    } catch {
        return quotes.join('；');
    }
};

export function configureDefaultCallbacks(engine: {
    setExtractor(extract: FactExtractor): void;
    setReranker(rerank: Reranker): void;
    setObservationSynthesizer(synthesizeObservation: ObservationSynthesizer): void;
}): void {
    engine.setExtractor(defaultFactExtractor);
    engine.setReranker(defaultReranker);
    engine.setObservationSynthesizer(defaultObservationSynthesizer);
}

