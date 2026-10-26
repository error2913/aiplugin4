// 记忆抽取提示词（纯字符串，L1）：只输出 facts；路由/可见性由 MemoryService 决定，不信任模型给的 bank。
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
Fact fields:
- memory_type: "private" | "group" | "global"
  private = a stable fact about one user; group = rules/conventions/shared facts of this group; global = the assistant's own experience (not extracted by default)
- target_id: the user ID for private, the group ID for group; may be omitted when it cannot be determined
- text: one atomic fact that cannot be split further; keep numbers/entities/negations/conditions and do not merge several facts
- type: "fact" | "rule" | "relation" | "event"
- keywords: array of strings (2-5 retrieval terms)
- related_user_ids / related_group_ids: arrays of related user/group IDs (optional)
- importance: 0-1
- visibility: "owner" (visible only in the owner's private chat) | "origin" (visible only in the source conversation) | "public" (the user explicitly agreed to share across groups)
- op: "add" | "update" | "delete"; use update/delete only for an explicit correction/deletion
- existing_id: target memory id for update/delete (optional)
- confidence: 0-1; the assistant's inferences about a user should be <= 0.6
- occurred_at: when the event happened (ISO date/time, optional)
- entities: array of entity names (optional)
- Do not record: greetings, one-off jokes, already outdated messages, sensitive privacy (passwords/ID documents/exact addresses).
- For facts about users in group chats, use visibility "origin" unless they explicitly agree otherwise.

${input.globalEnabled ? '' : '- Do not output memory_type=global.'}
${input.personalFromGroup ? '' : '- Do not output memory_type=private in group chats (when the owner cannot be reliably attributed, write into group memory).'}

Conversation content:
${input.content}`;
}
