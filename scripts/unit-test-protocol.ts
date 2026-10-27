// 协议常量单测：英文 raw 标记的构造/剥离、旧中文标记**不再识别**（锁定硬切）、
// systemName 与包装常量一致性、`raw_marker` 兼容入口 re-export 同源。
import assert from 'node:assert/strict';

import {
    AUX_HISTORY_OMIT_MARK,
    buildEventRangeTruncateMarker,
    buildImageTruncateMarker,
    buildReadRawRef,
    buildToolTruncateMarker,
    buildUserBlockMarker,
    buildUserSingleMarker,
    buildUserTruncateMarker,
    CONTEXT_BRIDGE_ROLE_LABEL,
    EARLIER_SUMMARY_HEADER,
    earlierSummaryBlock,
    earlierSummaryGapText,
    EXISTING_SUMMARY_HEADER,
    foldOmittedLine,
    foldSummaryHeader,
    hasRawMarker,
    NEW_CONTENT_HEADER,
    RAW_MARKER_COMPRESSED,
    RAW_MARKER_CONTENT_TRUNCATED,
    RAW_MARKER_IMAGE_TEXT_TRUNCATED,
    RAW_MARKER_PREFIXES,
    RAW_MARKER_TOOL_OUTPUT_TRUNCATED,
    stripRawMarkers,
    SUBAGENT_OMIT_HEADER,
    SUBAGENT_SUMMARY_HEADER,
    SUBAGENT_TRUNCATE_MARK,
    subagentOmitLine,
    SUMMARY_TRUNCATE_MARK,
    SYSTEM_NAME,
    TOOL_RESULT_CLOSE,
    TOOL_RESULT_OPEN,
    toolResultHeader,
    wrapToolResultText,
} from '../src/utils/protocol';
import { hasRawMarker as hasRawMarkerCompat, stripRawMarkers as stripRawMarkersCompat } from '../src/utils/raw_marker';

const ALL_PREFIXES = [
    RAW_MARKER_COMPRESSED,
    RAW_MARKER_CONTENT_TRUNCATED,
    RAW_MARKER_TOOL_OUTPUT_TRUNCATED,
    RAW_MARKER_IMAGE_TEXT_TRUNCATED,
];

export const tests: Record<string, () => void | Promise<void>> = {
    testProtocolRawMarkerBuilders() {
        assert.equal(
            buildUserSingleMarker(100, 10, 'm1'),
            '\n[content-compressed: 100 chars -> 10; read_raw kind=user id=m1]',
        );
        assert.equal(
            buildUserSingleMarker(100, 10, ''),
            '\n[content-compressed: 100 chars -> 10; no message id (use grep_raw kind=user)]',
        );
        assert.equal(
            buildUserBlockMarker(2, 300, 'm9'),
            '\n[content-compressed: merged 2 messages, 300 chars total; read_raw kind=user id=blk:m9]',
        );
        assert.equal(
            buildToolTruncateMarker(900, 50, 'call_1'),
            '\n[tool-output-truncated: 900 chars, first 50 shown; read_raw kind=tool id=call_1]',
        );
        assert.equal(
            buildUserTruncateMarker(500, 120, 'm2'),
            '\n[content-truncated: 500 chars, head+tail 120 shown; read_raw kind=user id=m2]',
        );
        assert.equal(
            buildImageTruncateMarker(800, 50, 'pic_1'),
            '\n[image-text-truncated: 800 chars, first 50 shown; read_raw kind=image id=pic_1]',
        );
        // 编译层事件区间截断（此前漏登记的第 5 个标记），按 e:<from>-<to> 回查
        assert.equal(
            buildEventRangeTruncateMarker(1200, 90, 3, 5),
            '\n[content-truncated: 1200 chars, head+tail 90 shown; read_raw id=e:3-5]',
        );
        assert.equal(
            buildReadRawRef('user', 'blk:m9'),
            'read_raw kind=user id=blk:m9',
        );
    },

    testProtocolStripEnglishMarkers() {
        const text = [
            '开头内容',
            buildUserSingleMarker(100, 10, 'm1'),
            '中间内容',
            buildToolTruncateMarker(900, 50, 'call_1'),
            buildImageTruncateMarker(800, 50, 'pic_1'),
            buildEventRangeTruncateMarker(1200, 90, 3, 5),
            buildUserBlockMarker(2, 300, 'm9'),
            '结尾内容',
        ].join('');
        const stripped = stripRawMarkers(text);
        for (const prefix of ALL_PREFIXES) assert.ok(!stripped.includes(prefix), `应剥离 ${prefix}`);
        assert.ok(stripped.includes('开头内容'));
        assert.ok(stripped.includes('中间内容'));
        assert.ok(stripped.includes('结尾内容'));
        // 幂等 + 空串安全
        assert.equal(stripRawMarkers(stripped), stripped);
        assert.equal(stripRawMarkers(''), '');
        // 兼容入口与唯一事实源行为一致
        assert.equal(stripRawMarkersCompat(text), stripped);
    },

    testProtocolLegacyChineseMarkersNotRecognized() {
        // 硬切：旧中文标记不是协议的一部分，不得被识别/剥离（不做 dual-read，无中文 legacy 正则）
        const legacy = [
            '前文[原文已压缩: 原100字现10字;原文 read_raw kind=user id=m1]',
            '[原文已截断: 共500字,仅展示头尾120字;原文 read_raw kind=user id=m2]',
            '[工具原文过长: 共900字,仅展示开头50字;完整原文 read_raw kind=tool id=call_1]',
            '[图片识别原文过长: 共800字,仅展示开头50字;完整原文 read_raw kind=image id=pic_1]',
            '[原文过长: 共1200字，仅显示头尾90字；完整原文 read_raw id=e:3-5]',
        ].join('\n');
        assert.equal(stripRawMarkers(legacy), legacy, '旧中文标记不应被剥离');
        assert.equal(hasRawMarker(legacy), false, '旧中文标记不应被识别');
        for (const prefix of ALL_PREFIXES) {
            assert.ok(!legacy.includes(`[${prefix}`), '测试输入不应含英文标记');
        }
    },

    testProtocolHasRawMarker() {
        assert.equal(hasRawMarker(''), false);
        assert.equal(hasRawMarker('plain text'), false);
        assert.equal(hasRawMarker(buildUserSingleMarker(1, 1, 'a')), true);
        assert.equal(hasRawMarker(buildToolTruncateMarker(1, 1, 'a')), true);
        assert.equal(hasRawMarker(buildImageTruncateMarker(1, 1, 'p')), true);
        assert.equal(hasRawMarker(buildEventRangeTruncateMarker(1, 1, 1, 2)), true);
        // 连续调用不受 global 正则 lastIndex 影响
        assert.equal(hasRawMarker(buildUserBlockMarker(2, 3, 'm')), true);
        assert.equal(hasRawMarker(buildUserBlockMarker(2, 3, 'm')), true);
        // 内部标签不是 raw 标记
        assert.equal(hasRawMarker('[tool_result:call_1]x[/tool_result]'), false);
        // 兼容入口一致
        assert.equal(hasRawMarkerCompat(buildUserSingleMarker(1, 1, 'a')), true);
        assert.equal(hasRawMarkerCompat('plain'), false);
    },

    testProtocolPrefixesAreAsciiEnglish() {
        assert.equal(RAW_MARKER_PREFIXES.length, 4);
        assert.deepEqual([...RAW_MARKER_PREFIXES], ALL_PREFIXES);
        for (const prefix of RAW_MARKER_PREFIXES) {
            assert.match(prefix, /^[a-z][a-z-]*$/, `prefix 必须是 ASCII 小写英文: ${prefix}`);
        }
        // 机器标识保持 ASCII
        assert.equal(toolResultHeader('read_raw'), '[tool_result:read_raw]');
    },

    testProtocolSystemNames() {
        assert.deepEqual({ ...SYSTEM_NAME }, {
            trigger: 'trigger',
            groupEvent: 'group-event',
            requestEvent: 'request-event',
            mediaTask: 'media-task',
            subagent: 'subagent',
            timer: 'timer',
            activeHours: 'active-hours',
            nudge: 'nudge',
            crossSession: 'cross-session',
            condensedHistory: 'condensed-history',
            preserved: 'preserved',
            event: 'event',
            eventTrigger: 'event-trigger',
        });
        for (const [key, value] of Object.entries(SYSTEM_NAME)) {
            assert.match(value, /^[a-z][a-z-]*$/, `${key} 必须是 ASCII 小写英文: ${value}`);
        }
    },

    testProtocolWrappers() {
        // 工具结果边界（native 与提示词工程统一）
        assert.equal(TOOL_RESULT_OPEN, '[tool_result]');
        assert.equal(TOOL_RESULT_CLOSE, '[/tool_result]');
        assert.equal(toolResultHeader(), '[tool_result]');
        assert.equal(toolResultHeader(undefined), '[tool_result]');
        assert.equal(toolResultHeader('call_1'), '[tool_result:call_1]');
        assert.equal(
            wrapToolResultText('read_raw', 'data'),
            '[tool_result:read_raw]\ndata\n[/tool_result]',
        );
        // 折叠摘要 / 辅助历史
        assert.ok(foldSummaryHeader(3).startsWith('Earlier chat/tool content was compacted into a summary (3 items;'));
        assert.ok(foldOmittedLine(2).startsWith('- 2 earlier messages omitted'));
        assert.equal(AUX_HISTORY_OMIT_MARK, '… (earlier content omitted)');
        // 更早内容摘要 / 缺口
        assert.equal(EARLIER_SUMMARY_HEADER, 'Earlier context summary');
        assert.equal(
            earlierSummaryBlock('summary body', 3, 5),
            'Earlier context summary (use read_raw id=e:3-5 for the originals):\nsummary body',
        );
        assert.ok(earlierSummaryGapText(3, 3, 5).startsWith('Earlier events were not summarized: about 3 events'));
        // 子代理上下文协议
        assert.equal(SUBAGENT_SUMMARY_HEADER, '## Earlier context summary (auto-compacted)');
        assert.equal(SUBAGENT_OMIT_HEADER, '[earlier context omitted]');
        assert.ok(subagentOmitLine(2).startsWith('[earlier context omitted] 2 earlier messages omitted'));
        assert.equal(SUBAGENT_TRUNCATE_MARK, '… (original too long; truncated)');
        // 滚动摘要输入与持久化截断标记
        assert.equal(EXISTING_SUMMARY_HEADER, '[existing summary]');
        assert.equal(NEW_CONTENT_HEADER, '[new content]');
        assert.equal(SUMMARY_TRUNCATE_MARK, '… (summary too long; truncated)');
        // 上下文桥角色标签
        assert.equal(CONTEXT_BRIDGE_ROLE_LABEL.user, '[user] ');
        assert.equal(CONTEXT_BRIDGE_ROLE_LABEL.assistant, '[AI] ');
        assert.equal(CONTEXT_BRIDGE_ROLE_LABEL.tool_result, '[tool] ');
    },
};
