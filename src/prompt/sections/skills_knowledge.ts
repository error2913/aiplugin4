// 能力清单段：可用技能 + 知识库（按平台/会话开关过滤，超预算截断）
import { formatSkillSummaryBlock, getSkillsSignature, getSkillSummariesBudgeted, SKILL_INJECT_MAX_CHARS, SKILL_INJECT_MAX_ITEMS } from '../../tool/skills';
import { matchesPlatform } from '../../utils/target_id';
import { getPromptMemorySource } from '../memory_source';
import type { PromptSection } from '../types';

/** 会话级技能/知识库关闭项签名（参与缓存 key） */
function offFlags(state: { [key: string]: boolean } | undefined): string {
    if (!state) return '';
    return Object.keys(state).filter(key => state[key] === false).sort().join(',');
}

export function registerSkillKnowledgeSections(): PromptSection[] {
    return [
        {
            name: 'core:skills',
            order: 600,
            channel: 'system',
            maxChars: 2000,
            cache: {
                deps: c => [
                    c.platform,
                    offFlags(c.session.skillState),
                    c.flags.status ? getSkillsSignature() : '',
                    `${SKILL_INJECT_MAX_CHARS}x${SKILL_INJECT_MAX_ITEMS}`,
                ],
            },
            build: c => {
                if (!c.flags.status) return '';
                const result = getSkillSummariesBudgeted(SKILL_INJECT_MAX_CHARS, SKILL_INJECT_MAX_ITEMS, skill =>
                    matchesPlatform(skill.platforms, c.platform) && c.session.skillState?.[skill.name] !== false);
                return formatSkillSummaryBlock(result);
            },
        },
        {
            name: 'core:knowledge',
            order: 700,
            channel: 'system',
            maxChars: 3000,
            cache: {
                deps: c => {
                    if (!c.flags.status || !c.flags.knowledge) return [c.flags.status, c.flags.knowledge];
                    const source = getPromptMemorySource();
                    return [c.platform, source.knowledgeSignature(), offFlags(c.session.kbState)];
                },
            },
            build: c => {
                if (!c.flags.status || !c.flags.knowledge) return '';
                const source = getPromptMemorySource();
                const enabled = new Set<string>();
                for (const id of source.knowledgeIds()) {
                    if (c.session.kbState?.[id] !== false) enabled.add(id);
                }
                return source.formatKnowledgeFor(c.platform, enabled);
            },
        },
    ];
}

/** 供 builder 在组装前预热知识库（幂等） */
export async function initKnowledgeBase(): Promise<void> {
    await getPromptMemorySource().initKnowledge();
}
