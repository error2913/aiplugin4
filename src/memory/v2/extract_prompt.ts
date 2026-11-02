// 记忆抽取提示词（纯字符串，L1）：只输出 facts；路由/可见性由 MemoryService 决定，不信任模型给的 bank。
import { FACT_FIELD_SPEC } from "../../core/fact_schema";

export interface ExtractPromptInput {
    platform: string;
    isPrivate: boolean;
    userName: string;
    userId: string;
    groupName: string;
    groupId: string;
    content: string;
    roleSetting?: string;
    globalEnabled?: boolean;
    personalFromGroup?: boolean;
}

export function buildExtractPrompt(input: ExtractPromptInput): string {
    const scope = input.isPrivate
        ? `private chat: ${input.userName}(${input.userId})`
        : `group chat: ${input.groupName}(${input.groupId})`;
    return `You extract long-term memory. Extract atomic facts from the conversation that are worth remembering long-term; when there is nothing worth remembering, facts is empty.
Write all generated text in the language of the conversation.
Output only JSON: {"facts":[{...}]}, with no explanation and no markdown.

Conversation scope: platform=${input.platform}, ${scope}
${input.roleSetting ? `Role setting: ${input.roleSetting}\n` : ''}
${FACT_FIELD_SPEC}

${input.globalEnabled ? '' : '- Do not output memory_type=global.'}
${input.personalFromGroup ? '' : '- Do not output memory_type=private in group chats (when the owner cannot be reliably attributed, write into group memory).'}

Conversation content:
${input.content}`;
}
