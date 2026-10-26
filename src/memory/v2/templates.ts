// 固定心智模型模板目录：问题写死、注入顺序写死；persona=设定 / preference=偏好 / rules=规则 / self_*=本体经验。
import type { BankKind, MentalModelTemplateId } from "./types";

export interface MentalModelTemplate {
    id: MentalModelTemplateId;
    question: string;
}

/**
 * FNV-1a（32 位，按 UTF-16 码元）。仅用于识别旧版中文问题的历史数据：
 * 官方文案已全量英文化，代码里不再保留旧中文问题字面量，改存预计算哈希。
 */
export function fnv1a32(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** 旧 persona 问题（合体 / 用户 / 群聊）的 FNV-1a 哈希；仅迁移历史数据时使用。 */
export const LEGACY_PERSONA_QUESTION_HASHES: readonly number[] = [
    0x150ffb5a, // 旧版合体问题
    0xae5c2c77, // 旧版用户问题
    0xadf6dbda, // 旧版群聊问题
];

/**
 * 旧版合体 persona 问题的代码内标记（历史字面量已删除，仅作为测试/迁移桩使用；
 * 真实历史数据由 `isLegacyPersonaQuestion` 按哈希识别）。
 */
export const LEGACY_PERSONA_QUESTION = 'legacy-persona-question';

/** 旧 persona 问题比对：按哈希识别，避免代码中出现中文字面量。 */
export function isLegacyPersonaQuestion(question: string): boolean {
    const text = String(question ?? '');
    return text === LEGACY_PERSONA_QUESTION || LEGACY_PERSONA_QUESTION_HASHES.includes(fnv1a32(text));
}

export const PERSONA_QUESTION_USER = "What is this user's persona and setting?";
export const PERSONA_QUESTION_GROUP = "What is this group's persona and setting?";

/** 当前模板版本：每新增/调整模板目录 +1，存量 bank 只补新条目 */
export const TEMPLATE_VERSION = 2;

export const MENTAL_MODEL_TEMPLATES: Record<'user' | 'group' | 'global', MentalModelTemplate[]> = {
    user: [
        { id: 'persona', question: PERSONA_QUESTION_USER },
        { id: 'preference', question: 'What long-term preferences, habits or pet peeves does this user have?' },
    ],
    group: [
        { id: 'persona', question: PERSONA_QUESTION_GROUP },
        { id: 'rules', question: 'What rules, conventions or taboos does this group have?' },
    ],
    global: [
        { id: 'self_rules', question: 'What consistent interaction rules should I follow across all conversations?' },
        { id: 'self_experience', question: 'What effective experience have I accumulated through long-term interaction?' },
    ],
};

export function personaQuestionFor(kind: BankKind | string): string {
    return kind === 'group' ? PERSONA_QUESTION_GROUP : PERSONA_QUESTION_USER;
}

export function mentalModelTemplatesFor(kind: BankKind): MentalModelTemplate[] {
    if (kind === 'group') return MENTAL_MODEL_TEMPLATES.group;
    if (kind === 'global') return MENTAL_MODEL_TEMPLATES.global;
    return MENTAL_MODEL_TEMPLATES.user;
}

export function bankKindOfBankId(bankId: string): BankKind {
    const sep = bankId.indexOf('_');
    const prefix = sep >= 0 ? bankId.slice(0, sep) : bankId;
    if (prefix === 'user' || prefix === 'group' || prefix === 'global') return prefix;
    return 'global';
}
