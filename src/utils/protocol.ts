// 上下文协议常量与构造器（L0 叶子，唯一事实源）。
//
// 本文件集中所有**代码生成、模型可见**的协议文本：raw 标记、包装前缀、`[system:<name>]` 名义、
// 上下文桥标签等。约定：
// - 全部英文；旧中文标记/包装**不保留兼容**（硬切，正则只认英文）；
// - 机器标识保持 ASCII：工具名、`read_raw kind=... id=...`、标签语法 `[system:...]`/`[tool_result]`；
// - 本文件**不 import 任何模块**（config/context/prompt/tool/memory/logger 一律不引），
//   供 L1+ 各层直接引用，避免协议文本散落与依赖环；
// - 日志/`.ai` UI 文案仍用中文，不进本文件。

// ---------------- raw 标记（压缩/截断指针） ----------------

/** 标记种类：用户消息、工具结果、图片识别文本 */
export type RawMarkerKind = 'user' | 'tool' | 'image';

/** 单条用户消息压缩 */
export const RAW_MARKER_COMPRESSED = 'content-compressed';
/** 内容截断（用户消息冷态截断 + 编译层事件区间截断共用） */
export const RAW_MARKER_CONTENT_TRUNCATED = 'content-truncated';
/** 工具输出截断 */
export const RAW_MARKER_TOOL_OUTPUT_TRUNCATED = 'tool-output-truncated';
/** 图片识别文本截断 */
export const RAW_MARKER_IMAGE_TEXT_TRUNCATED = 'image-text-truncated';

/**
 * 全部 raw 标记前缀词（**只含英文**；旧中文前缀已删除，不做 dual-read）。
 * 与内部标签剥离名单（from/msg_id/system/time/tool_result）及可发送标签名单不冲突。
 */
export const RAW_MARKER_PREFIXES: readonly string[] = [
    RAW_MARKER_COMPRESSED,
    RAW_MARKER_CONTENT_TRUNCATED,
    RAW_MARKER_TOOL_OUTPUT_TRUNCATED,
    RAW_MARKER_IMAGE_TEXT_TRUNCATED,
];

/** 标记正则：`[<prefix>: ...]`，含标记前换行；仅英文前缀 */
const RAW_MARKER_RE = new RegExp(
    `\\n?\\s*\\[(?:${RAW_MARKER_PREFIXES.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):[^\\]\\n]*\\]`,
    'g',
);

/** `read_raw` 指针子句：`read_raw kind=user id=X` */
export function buildReadRawRef(kind: RawMarkerKind, id: string): string {
    return `read_raw kind=${kind} id=${id}`;
}

/**
 * 生成单条用户消息压缩标记。
 * @param originalLength 压缩前原文长度
 * @param displayLength 压缩后展示文本长度
 * @param messageId 该条原始消息 ID（可能为空；空时提示改用 grep_raw）
 */
export function buildUserSingleMarker(originalLength: number, displayLength: number, messageId: string): string {
    const ref = messageId
        ? buildReadRawRef('user', messageId)
        : 'no message id (use grep_raw kind=user)';
    return `\n[${RAW_MARKER_COMPRESSED}: ${originalLength} chars -> ${displayLength}; ${ref}]`;
}

/**
 * 生成连续多条合并压缩块标记。
 * @param count 合并的原始消息条数
 * @param totalLength 合并前的总原文长度
 * @param lastMessageId 块内末条消息 ID（即展示条目的 messageId）
 */
export function buildUserBlockMarker(count: number, totalLength: number, lastMessageId: string): string {
    const ref = lastMessageId
        ? buildReadRawRef('user', `blk:${lastMessageId}`)
        : 'no message id (use grep_raw kind=user)';
    return `\n[${RAW_MARKER_COMPRESSED}: merged ${count} messages, ${totalLength} chars total; ${ref}]`;
}

/** 工具结果截断标记；完整原文按 tool_call_id 回查 */
export function buildToolTruncateMarker(totalLength: number, shownLength: number, toolCallId: string): string {
    return `\n[${RAW_MARKER_TOOL_OUTPUT_TRUNCATED}: ${totalLength} chars, first ${shownLength} shown; ${buildReadRawRef('tool', toolCallId)}]`;
}

/**
 * 用户消息"冷态纯代码截断"标记（待机时不调用压缩智能体，只留头留尾）。
 * @param totalLength 截断前原文长度
 * @param shownLength 实际展示（头+尾）长度
 * @param messageId 该条消息 ID（空时提示改用 grep_raw）
 */
export function buildUserTruncateMarker(totalLength: number, shownLength: number, messageId: string): string {
    const ref = messageId
        ? buildReadRawRef('user', messageId)
        : 'no message id (use grep_raw kind=user)';
    return `\n[${RAW_MARKER_CONTENT_TRUNCATED}: ${totalLength} chars, head+tail ${shownLength} shown; ${ref}]`;
}

/** 图片识别文本截断标记；完整原文按 image_id 回查 */
export function buildImageTruncateMarker(totalLength: number, shownLength: number, imageId: string): string {
    return `\n[${RAW_MARKER_IMAGE_TEXT_TRUNCATED}: ${totalLength} chars, first ${shownLength} shown; ${buildReadRawRef('image', imageId)}]`;
}

/**
 * 编译层事件区间截断标记（此前未登记的第 5 个标记，现已纳入统一常量）。
 * 按事件区间地址 `e:<from>-<to>` 回查原文。
 */
export function buildEventRangeTruncateMarker(totalLength: number, shownLength: number, fromSeq: number, toSeq: number): string {
    const address = fromSeq === toSeq ? `e:${fromSeq}` : `e:${fromSeq}-${toSeq}`;
    return `\n[${RAW_MARKER_CONTENT_TRUNCATED}: ${totalLength} chars, head+tail ${shownLength} shown; read_raw id=${address}]`;
}

/** 剥离文本中注入的压缩/截断标记（含标记前的换行；合并压缩、摘要等再加工前清理，避免噪音进入 LLM） */
export function stripRawMarkers(text: string): string {
    if (!text) return text;
    return text.replace(RAW_MARKER_RE, '');
}

/** 判断文本是否携带任一 raw 标记（仅英文） */
export function hasRawMarker(text: string): boolean {
    if (!text) return false;
    RAW_MARKER_RE.lastIndex = 0;
    return RAW_MARKER_RE.test(text);
}

// ---------------- systemName（`[system:<name>]`） ----------------

/** `[system:<name>]` 的名义常量（全英文；代码中无按 systemName 匹配的逻辑，改名只影响渲染与测试） */
export const SYSTEM_NAME = {
    /** 触发原因提示 */
    trigger: 'trigger',
    /** 群事件提示 */
    groupEvent: 'group-event',
    /** 请求事件提示 */
    requestEvent: 'request-event',
    /** 媒体生成任务 */
    mediaTask: 'media-task',
    /** 子代理 */
    subagent: 'subagent',
    /** 定时器触发 */
    timer: 'timer',
    /** 活跃时间触发 */
    activeHours: 'active-hours',
    /** 任务续跑提示 */
    nudge: 'nudge',
    /** 跨端消息 */
    crossSession: 'cross-session',
    /** 折叠摘要 */
    condensedHistory: 'condensed-history',
    /** 迁移保留 */
    preserved: 'preserved',
    /** 事件缺省兜底 */
    event: 'event',
} as const;

export type SystemName = typeof SYSTEM_NAME[keyof typeof SYSTEM_NAME];

// ---------------- 工具结果包装（native 与 PE 统一） ----------------

export const TOOL_RESULT_OPEN = '[tool_result]';
export const TOOL_RESULT_CLOSE = '[/tool_result]';

/** 工具结果头：`[tool_result]` / `[tool_result:nameOrId]` */
export function toolResultHeader(nameOrId?: string | null): string {
    const name = nameOrId === undefined || nameOrId === null ? '' : String(nameOrId).trim();
    return name ? `[tool_result:${name}]` : TOOL_RESULT_OPEN;
}

/** 把一段文本包成工具结果边界（native 与提示词工程统一） */
export function wrapToolResultText(nameOrId: string | undefined | null, text: string): string {
    return `${toolResultHeader(nameOrId)}\n${text}\n${TOOL_RESULT_CLOSE}`;
}

// ---------------- 更早内容（编译层摘要 / 缺口） ----------------

/** 更早内容摘要头（编译层注入） */
export const EARLIER_SUMMARY_HEADER = 'Earlier context summary';

/** 更早内容摘要注入文本：摘要正文 + read_raw 区间指针 */
export function earlierSummaryBlock(summaryText: string, fromSeq: number, toSeq: number): string {
    const address = fromSeq === toSeq ? `e:${fromSeq}` : `e:${fromSeq}-${toSeq}`;
    return `${EARLIER_SUMMARY_HEADER} (use read_raw id=${address} for the originals):\n${summaryText}`;
}

/** 更早内容未摘要缺口提示（绝不静默）：约 count 条事件无摘要，可按区间回查 */
export function earlierSummaryGapText(count: number, fromSeq: number, toSeq: number): string {
    const address = fromSeq === toSeq ? `e:${fromSeq}` : `e:${fromSeq}-${toSeq}`;
    return `Earlier events were not summarized: about ${Math.max(0, count)} events have no summary; use read_raw id=${address} to read the originals.`;
}

// ---------------- 折叠摘要 / 辅助历史 ----------------

/** 折叠摘要头（`src/utils/message.ts` 的窗口折叠） */
export function foldSummaryHeader(count: number): string {
    return `Earlier chat/tool content was compacted into a summary (${count} items; use read_raw / grep_raw to look up originals):`;
}

/** 折叠明细放不下时的省略行 */
export function foldOmittedLine(count: number): string {
    return `- ${count} earlier messages omitted (same as above; look up originals on demand)`;
}

/** 辅助请求（judge 等）窗口历史被硬截断时的省略标记 */
export const AUX_HISTORY_OMIT_MARK = '… (earlier content omitted)';

// ---------------- 子代理上下文压缩 ----------------

/** 子代理 system 里注入的摘要段头（重复压缩时先剥离） */
export const SUBAGENT_SUMMARY_HEADER = '## Earlier context summary (auto-compacted)';
/** 子代理降级省略段头 */
export const SUBAGENT_OMIT_HEADER = '[earlier context omitted]';
/** 子代理降级省略说明行 */
export function subagentOmitLine(droppedMessages: number): string {
    return `${SUBAGENT_OMIT_HEADER} ${droppedMessages} earlier messages omitted (auto-compaction failed; recent content kept)`;
}
/** 子代理内容中段截断标记 */
export const SUBAGENT_TRUNCATE_MARK = '… (original too long; truncated)';

/** 滚动摘要输入分段（压缩器与子代理共用） */
export const EXISTING_SUMMARY_HEADER = '[existing summary]';
export const NEW_CONTENT_HEADER = '[new content]';

/** 摘要文本超上限后的截断标记（**会持久化**进 SummaryRecord，勿随意改动） */
export const SUMMARY_TRUNCATE_MARK = '… (summary too long; truncated)';

// ---------------- 上下文桥角色标签 ----------------

/** 记忆桥 pending 文本的角色标签（`src/agent/context_bridge.ts`） */
export const CONTEXT_BRIDGE_ROLE_LABEL: Readonly<Record<string, string>> = {
    user: '[user] ',
    assistant: '[AI] ',
    tool_result: '[tool] ',
};
