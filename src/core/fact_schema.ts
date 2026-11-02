// 记忆事实字段说明（L0 纯字符串）：抽取 prompt 与归档合并 prompt 共用，避免两份漂移。
// 注意：这是模型可见的英文说明，改动会影响抽取质量，需与测试群灰度。

export const FACT_FIELD_SPEC = `Fact fields:
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
- For facts about users in group chats, use visibility "origin" unless they explicitly agree otherwise.`;
