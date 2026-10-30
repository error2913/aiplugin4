// 基础段：身份 / 全局提示词 / 角色 / 回复语言 / 会话信息 / 消息标记 / 图片图库 / 回复方式 / 工作方向
import { GLOBAL_HEADING, IDENTITY, IMAGE_USAGE, markersSection, REPLY_STYLE, RESPONSE_LANGUAGE, ROLE_HEADING, sessionSection, WORK_DIRECTION } from '../texts/en';
import type { PromptSection } from '../types';

export function registerCoreGeneralSections(): PromptSection[] {
    const sections: PromptSection[] = [
        {
            name: 'core:identity',
            order: -1000,
            channel: 'system',
            cache: { deps: () => [] },
            build: () => IDENTITY,
        },
        {
            name: 'core:global',
            order: -950,
            channel: 'system',
            cache: { deps: c => [c.globalPrompt] },
            build: c => (c.globalPrompt ? `${GLOBAL_HEADING}\n${c.globalPrompt}` : ''),
        },
        {
            name: 'core:role',
            order: -900,
            channel: 'system',
            cache: { deps: c => [c.roleSetting] },
            build: c => {
                const role = String(c.roleSetting || '').trim();
                return `${ROLE_HEADING}\n${role || 'No role setting provided; act as a helpful dice bot.'}`;
            },
        },
        {
            name: 'core:language',
            order: -800,
            channel: 'system',
            cache: { deps: () => [] },
            build: () => RESPONSE_LANGUAGE,
        },
        {
            name: 'core:session',
            order: 0,
            channel: 'system',
            cache: { deps: c => [c.platform, c.isPrivate ? 'private' : 'group', c.sessionName, c.sessionId, c.botId] },
            build: c => sessionSection({
                platform: c.platform,
                sessionType: c.isPrivate ? 'private' : 'group',
                sessionName: c.sessionName,
                sessionId: c.sessionId,
                botId: c.botId,
            }),
        },
        {
            name: 'core:markers',
            order: 100,
            channel: 'system',
            cache: { deps: c => [c.flags.receiveImage, c.flags.extraSeparator.join('|')] },
            build: c => markersSection(c.flags.receiveImage, c.flags.extraSeparator),
        },
        {
            name: 'core:images',
            order: 200,
            channel: 'system',
            maxChars: 3000,
            // 只用 imageUsage（接收图片 || 图床 || 资源段）；图库/图床规则拆到 core:image-host（order 221）
            cache: { deps: c => [c.flags.imageUsage] },
            build: c => (c.flags.imageUsage ? IMAGE_USAGE : ''),
        },
        {
            name: 'core:reply',
            order: 300,
            channel: 'system',
            cache: { deps: () => [] },
            build: () => REPLY_STYLE,
        },
        {
            name: 'core:direction',
            order: 400,
            channel: 'system',
            maxChars: 1500,
            cache: { deps: c => [c.flags.directionPrompt] },
            build: c => (c.flags.directionPrompt ? WORK_DIRECTION : ''),
        },
    ];
    return sections;
}
