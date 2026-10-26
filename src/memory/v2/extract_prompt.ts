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
        ? `私聊：${input.userName}(${input.userId})`
        : `群聊：${input.groupName}(${input.groupId})`;
    return `你是长期记忆抽取器。从对话中抽取值得长期记住的原子事实；没有可记内容时 facts 为空。
只输出 JSON：{"facts":[{...}]}，不要解释、不要 markdown。

对话范围：平台=${input.platform}，${scope}
${input.roleSetting ? `角色设定：${input.roleSetting}\n` : ''}
事实字段：
- memory_type: "private" | "group" | "global"
  private=关于某个用户的稳定事实；group=本群规则/约定/群内共同事实；global=助手本体经验（默认不抽取）
- target_id: private 时的用户ID、group 时的群ID；无法确定可省略
- text: 一条不可再分的原子事实，保留数字/实体/否定/条件，不要合并多条
- type: "fact" | "rule" | "relation" | "event"
- keywords: 字符串数组（2-5 个检索词）
- related_user_ids / related_group_ids: 相关用户/群 ID 数组（可选）
- importance: 0-1
- visibility: "owner"（仅本人私聊可见）| "origin"（仅来源会话可见）| "public"（用户明确同意跨群共享）
- op: "add" | "update" | "delete"；只有明确纠正/删除时才用 update/delete
- existing_id: update/delete 时的目标记忆 id（可选）
- confidence: 0-1；助手关于用户的推断应 <=0.6
- occurred_at: 事件发生时间（ISO/中文日期，可选）
- entities: 实体名数组（可选）
- 不要记录：寒暄、一次性玩笑、已经过时的消息、敏感隐私（密码/证件/住址精确值）。
- 群聊中关于用户的事实，除非明确同意，否则 visibility 用 "origin"。

${input.globalEnabled ? '' : '- 不允许输出 memory_type=global。'}
${input.personalFromGroup ? '' : '- 群聊中不要输出 memory_type=private（无法可靠归属时写入群记忆）。'}

对话内容：
${input.content}`;
}
