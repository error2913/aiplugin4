// 固定心智模型模板目录：问题写死、注入顺序写死；persona=设定 / preference=偏好 / rules=规则 / self_*=本体经验。
import type { BankKind, MentalModelTemplateId } from "./types";

export interface MentalModelTemplate {
    id: MentalModelTemplateId;
    question: string;
}

/** 旧 persona 合体问题（仅迁移用） */
export const LEGACY_PERSONA_QUESTION = '这个用户/群的设定是什么？';
export const PERSONA_QUESTION_USER = '这个用户的设定是什么？';
export const PERSONA_QUESTION_GROUP = '这个群聊的设定是什么？';

/** 当前模板版本：每新增/调整模板目录 +1，存量 bank 只补新条目 */
export const TEMPLATE_VERSION = 2;

export const MENTAL_MODEL_TEMPLATES: Record<'user' | 'group' | 'global', MentalModelTemplate[]> = {
    user: [
        { id: 'persona', question: PERSONA_QUESTION_USER },
        { id: 'preference', question: '这个用户有哪些长期偏好、习惯或雷点？' },
    ],
    group: [
        { id: 'persona', question: PERSONA_QUESTION_GROUP },
        { id: 'rules', question: '这个群聊有哪些规则、约定或禁忌？' },
    ],
    global: [
        { id: 'self_rules', question: '我在各个会话中应遵守哪些一致的互动规则？' },
        { id: 'self_experience', question: '我在长期互动中积累了哪些有效经验？' },
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
