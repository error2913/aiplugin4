// 固定心智模型模板目录：问题写死、注入顺序写死。
// 设计约束：
// - question 即去重键，模板问题一经发布不再改文案；升级只能新增条目（TEMPLATE_VERSION+1）
// - 版本化播种：seededMentalModelVersion 推进后删除不会自动复活，版本升级只增量补新
import type { BankKind, MentalModelTemplateId } from "./types";

export interface MentalModelTemplate {
    id: MentalModelTemplateId;
    question: string;
}

/** 旧 persona 合体问题（仅迁移用）：v4.20 前 persona 懒迁移/旧档迁移写入的问题名 */
export const LEGACY_PERSONA_QUESTION = '这个用户/群的设定是什么？';
export const PERSONA_QUESTION_USER = '这个用户的设定是什么？';
export const PERSONA_QUESTION_GROUP = '这个群聊的设定是什么？';

/** 当前模板版本：每新增/调整模板目录 +1，存量 bank 只补新条目 */
export const TEMPLATE_VERSION = 1;

/** 按场景写死的模板目录（目录顺序 = 固定注入顺序） */
export const MENTAL_MODEL_TEMPLATES: Record<'user' | 'group', MentalModelTemplate[]> = {
    user: [
        { id: 'persona', question: PERSONA_QUESTION_USER },
        { id: 'preference', question: '这个用户有哪些长期偏好、习惯或雷点？' },
    ],
    group: [
        { id: 'persona', question: PERSONA_QUESTION_GROUP },
        { id: 'rules', question: '这个群聊有哪些规则、约定或禁忌？' },
    ],
};

/** persona（设定）问题按 bank kind 取专属文案 */
export function personaQuestionFor(kind: BankKind | string): string {
    return kind === 'group' ? PERSONA_QUESTION_GROUP : PERSONA_QUESTION_USER;
}

/** 按 bank kind 取固定模板目录（global 无模板） */
export function mentalModelTemplatesFor(kind: BankKind): MentalModelTemplate[] {
    if (kind === 'group') return MENTAL_MODEL_TEMPLATES.group;
    return MENTAL_MODEL_TEMPLATES.user;
}

/** 由 bankId（user_xxx / group_xxx / global_xxx）反推 kind，旧档迁移用 */
export function bankKindOfBankId(bankId: string): BankKind {
    const sep = bankId.indexOf('_');
    const prefix = sep >= 0 ? bankId.slice(0, sep) : bankId;
    if (prefix === 'user' || prefix === 'group' || prefix === 'global') return prefix;
    return 'global';
}
