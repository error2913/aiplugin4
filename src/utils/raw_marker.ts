// 「压缩/截断」指针标记：内容因压缩（LLM）或截断（纯代码）与完整原文不一致时，在展示文本末尾追加一行自解释标记，
// 让模型知道该条只展示了摘要/开头，并携带可寻址 id（tool_call_id / msg_id / blk:xxx / image_id），按标记调用
// read_raw / grep_raw 即可核对原文。
//
// 注意：标记以「原文已压缩/工具原文过长/图片识别原文过长」开头，不在内部标签剥离名单（from/msg_id/system/time/tool_result）
// 与可发送标签名单（at/poke/quote/img/avatar/...）内，因此不会被 stripInternalTags/stripUserTags/stripRenderTags 误剥，
// 也不会被发送解析当作消息段。标记始终放在文本末尾，即使发生预算兜底「保留尾部」截断，id 信息仍然存活。

/** 全部标记前缀词，与内部标签剥离名单不冲突 */
export const RAW_MARKER_PREFIXES: string[] = ['原文已压缩', '工具原文过长', '图片识别原文过长'];

/**
 * 生成单条用户消息压缩标记。
 * @param originalLength 压缩前原文长度
 * @param displayLength 压缩后展示文本长度
 * @param messageId 该条原始消息 ID（可能为空，空时省略 id 子句，模型可改用 grep_raw 按内容定位）
 */
export function buildUserSingleMarker(originalLength: number, displayLength: number, messageId: string): string {
    const idText = messageId ? `;原文 read_raw kind=user id=${messageId}` : ';原文 read_raw kind=user（无消息ID，可 grep_raw 检索）';
    return `\n[原文已压缩: 原${originalLength}字现${displayLength}字${idText}]`;
}

/**
 * 生成连续多条合并压缩块标记。
 * @param count 合并的原始消息条数
 * @param totalLength 合并前的总原文长度
 * @param lastMessageId 块内末条消息 ID（即展示条目的 messageId）
 */
export function buildUserBlockMarker(count: number, totalLength: number, lastMessageId: string): string {
    const idText = lastMessageId ? `id=blk:${lastMessageId}` : '无消息ID（可 grep_raw kind=user 检索）';
    return `\n[原文已压缩: 合并${count}条共${totalLength}字;块内原文 read_raw kind=user ${idText}]`;
}

/** 工具回调结果截断标记 */
export function buildToolTruncateMarker(totalLength: number, shownLength: number, toolCallId: string): string {
    return `\n[工具原文过长: 共${totalLength}字,仅展示开头${shownLength}字;完整原文 read_raw kind=tool id=${toolCallId}]`;
}

/** 图片识别文本截断标记 */
export function buildImageTruncateMarker(totalLength: number, shownLength: number, imageId: string): string {
    return `\n[图片识别原文过长: 共${totalLength}字,仅展示开头${shownLength}字;完整原文 read_raw kind=image id=${imageId}]`;
}

const RAW_MARKER_RE = new RegExp(`\\n?\\s*\\[(?:${RAW_MARKER_PREFIXES.join('|')})[:：][^\\]］]*[\\]］]`, 'g');

/** 剥离文本中我们注入的压缩/截断标记（含标记前的换行；合并压缩、摘要等再加工前清理前驱标记，避免噪音进入 LLM） */
export function stripRawMarkers(text: string): string {
    if (!text) return text;
    return text.replace(RAW_MARKER_RE, '');
}

/** 判断文本是否携带任一 raw 标记 */
export function hasRawMarker(text: string): boolean {
    if (!text) return false;
    RAW_MARKER_RE.lastIndex = 0;
    return RAW_MARKER_RE.test(text);
}
