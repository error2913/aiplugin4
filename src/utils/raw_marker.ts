// 「压缩/截断」指针标记的兼容入口：唯一事实源已迁至 `protocol.ts`（L0 叶子）。
// 本文件只做同名 re-export，既有 import（context/**、resource/image_inbound、tool/**）零改动。
//
// 注意：标记本体与正则均为**英文、仅英文**（旧中文前缀已删除，不做 dual-read）。
// 标记以 `[content-compressed: …]` / `[content-truncated: …]` / `[tool-output-truncated: …]` /
// `[image-text-truncated: …]` 开头，不在内部标签剥离名单与可发送标签名单内，因此不会被
// stripInternalTags/stripUserTags/stripRenderTags 误剥；标记始终放在文本末尾，即使被兜底截断，
// 可寻址 id 仍然存活。
export {
    buildEventRangeTruncateMarker,
    buildImageTruncateMarker,
    buildReadRawRef,
    buildToolTruncateMarker,
    buildUserBlockMarker,
    buildUserSingleMarker,
    buildUserTruncateMarker,
    hasRawMarker,
    RAW_MARKER_COMPRESSED,
    RAW_MARKER_CONTENT_TRUNCATED,
    RAW_MARKER_IMAGE_TEXT_TRUNCATED,
    RAW_MARKER_PREFIXES,
    RAW_MARKER_TOOL_OUTPUT_TRUNCATED,
    stripRawMarkers,
} from './protocol';
export type { RawMarkerKind } from './protocol';
