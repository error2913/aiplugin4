// 动态段：子代理委派 / 当前时间 / 记忆提示 / 长期记忆（runtime 通道）
import Model from '../../model/model';
import { buildDelegationGuide } from '../../subagent/limits';
import { fmtDate } from '../../utils/string';
import { getPromptMemorySource } from '../memory_source';
import { MEMORY_HINT, TIME_HEADING } from '../texts/en';
import type { PromptSection } from '../types';

export function registerDynamicSections(): PromptSection[] {
    return [
        {
            name: 'core:delegation',
            order: 800,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: c => [c.flags.status, String(c.tool('subagent')), String(c.tool('subagent_fork'))] },
            build: c => (c.flags.status ? buildDelegationGuide(c.session.toolState) : ''),
        },
        {
            name: 'core:time',
            order: 900,
            channel: 'runtime',
            build: () => `${TIME_HEADING}\n${fmtDate(Math.floor(Date.now() / 1000))}`,
        },
        {
            name: 'core:memory-hint',
            order: 910,
            channel: 'runtime',
            cache: { deps: c => [c.flags.memory] },
            build: c => (c.flags.memory ? MEMORY_HINT : ''),
        },
        {
            name: 'core:memory',
            order: 920,
            channel: 'runtime',
            maxChars: 20000,
            cache: {
                ttlMs: 10_000,
                deps: c => {
                    if (!c.flags.memory) return [c.flags.memory];
                    const source = getPromptMemorySource();
                    return [
                        source.memoryRevision(),
                        source.summaryRevision(),
                        Model.getEmbeddingDimension(),
                        Model.getEmbeddingModel('text-embedding')?.name || '',
                        c.session.sessionId,
                        c.session.memory.persona || '',
                        seal.formatTmpl(c.ctx, '核心:骰子名字'),
                        c.memoryUsers.map(user => user.id).join(','),
                        c.memoryUsers.map(user => user.name).join(','),
                        c.memoryGroup?.id || '',
                        c.memoryGroup?.name || '',
                        c.memoryQuery,
                    ];
                },
            },
            build: c => {
                if (!c.flags.memory) return '';
                return getPromptMemorySource().buildLongTermPrompt(c.ctx, c.session, c.memoryQuery, c.memoryUsers, c.memoryGroup);
            },
        },
    ];
}
