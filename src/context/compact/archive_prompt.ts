// 归档合并 prompt（P0-4）：一次请求同时产出「滚动摘要」与「本段 facts」。
//
// 输入分两段，语义不同：
// - Existing rolling summary：只用于保持连续性，禁止从中抽取 facts（否则每批都重复抽旧内容）；
// - New conversation segment：本次即将归档的原文，是 facts 的唯一来源。
import { FACT_FIELD_SPEC } from "../../core/fact_schema";

export interface ArchivePromptInput {
    previousSummary: string;
    segmentText: string;
    /** 会话范围（platform / 群或私聊 / target id），供 facts 路由判断 */
    scopeLine?: string;
    /** false 时只要求 summary（EXTRACT_ENABLED/MEMORY_ENABLED 关闭） */
    extractEnabled?: boolean;
    /** 角色设定（可选） */
    roleSetting?: string;
}

export function buildArchivePrompt(input: ArchivePromptInput): string {
    const extract = input.extractEnabled !== false;
    const previous = input.previousSummary && input.previousSummary.trim()
        ? input.previousSummary.trim()
        : '(none)';
    return `You are a context archiver and long-term memory extractor.
You archive the OLDEST part of a conversation into a rolling summary, and at the same time extract long-term memory facts from that part.

[Existing rolling summary]
${previous}

[New conversation segment]
${input.scopeLine ? `${input.scopeLine}\n` : ''}${input.roleSetting ? `Role setting: ${input.roleSetting}\n` : ''}${input.segmentText}

Output only JSON: {"summary":"...","facts":[...]}
Rules:
- summary: rewrite the COMPLETE rolling summary (existing + new segment). Keep the key facts, numbers, decisions, constraints and open items. Do not mention that you are summarizing. No more than 2000 characters.
- facts: extract only from [New conversation segment]. NEVER extract facts from [Existing rolling summary].
- If a fact is already fully covered by the existing summary, do not output it again.
${extract ? `- At most 12 facts; skip anything not worth remembering long-term.\n${FACT_FIELD_SPEC}` : '- Output "facts": [].'}
- For tool results in the segment, only the pointer is available; do not invent their content.
- Write all generated text in the language of the conversation.`;
}
