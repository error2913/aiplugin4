// Context v2 契约层单测：head 默认/修复、存储键命名、eventId 稳定性（P0）。
import assert from 'node:assert/strict';

import {
    CONTEXT_SCHEMA_VERSION,
    assistantEventId,
    fallbackEventId,
    systemEventId,
    toolCallEventId,
    toolResultEventId,
    userEventId,
} from '../src/context/events';
import { createEmptyHead, normalizeHead, parseHead, serializeHead } from '../src/context/head';
import {
    blobKey,
    eventPageKey,
    headKey,
    legacySessionKey,
    legacyShardKey,
    padPageNo,
    recordPageKey,
} from '../src/context/keys';

export const tests: Record<string, () => void | Promise<void>> = {
    testContextV2HeadDefaults() {
        const head = createEmptyHead();
        assert.equal(head.version, CONTEXT_SCHEMA_VERSION);
        assert.equal(head.epoch, 1);
        assert.equal(head.epochStartSeq, 1);
        assert.equal(head.nextSeq, 1);
        assert.equal(head.persistedSeq, 0);
        assert.equal(head.nextPageNo, 1);
        assert.equal(head.pageFloor, 1);
        assert.equal(head.nextRecPageNo, 1);
        assert.equal(head.recFloor, 1);
        assert.equal(head.summarizedThrough, 0);
        assert.equal(head.bytesTotal, 0);
        assert.equal(head.legacy, undefined);
    },

    testContextV2HeadNormalizeRepairs() {
        const repaired = normalizeHead({
            version: CONTEXT_SCHEMA_VERSION,
            epoch: 3,
            epochStartSeq: 10,
            nextSeq: 2,              // 小于 epochStartSeq → 抬到 10
            persistedSeq: 999,       // 超过 nextSeq-1 → 收到 9
            nextPageNo: 5,
            pageFloor: 99,           // 超过 nextPageNo → 收到 5
            nextRecPageNo: 2,
            recFloor: 0,
            summarizedThrough: 999,  // 超界 → 收到 nextSeq-1
            unsummarizedTokens: -5,  // 负 → 0
            bytesTotal: '12' as unknown as number,
            legacy: { archiveSeq: 1, rawSeq: 2, settledSeq: 3, phase: 'weird' },
        });
        assert.ok(repaired);
        assert.equal(repaired!.epochStartSeq, 10);
        assert.equal(repaired!.nextSeq, 10);
        assert.equal(repaired!.persistedSeq, 9);
        assert.equal(repaired!.pageFloor, 5);
        assert.equal(repaired!.recFloor, 1);
        assert.equal(repaired!.summarizedThrough, 9);
        assert.equal(repaired!.unsummarizedTokens, 0);
        assert.equal(repaired!.bytesTotal, 12);
        assert.equal(repaired!.legacy?.phase, 'flipped');
    },

    testContextV2HeadNormalizeRejects() {
        assert.equal(normalizeHead(null), null);
        assert.equal(normalizeHead({}), null);
        assert.equal(normalizeHead({ version: 1 }), null);
        assert.equal(parseHead('not json'), null);
        assert.equal(parseHead(''), null);
        assert.equal(parseHead(serializeHead(createEmptyHead()))?.version, CONTEXT_SCHEMA_VERSION);
    },

    testContextV2Keys() {
        assert.equal(padPageNo(1), '000001');
        assert.equal(padPageNo(123456), '123456');
        assert.equal(headKey('QQ-Group:1'), 'ctx_head:QQ-Group:1');
        assert.equal(eventPageKey('QQ-Group:1', 1), 'evt:QQ-Group:1:000001');
        assert.equal(recordPageKey('QQ-Group:1', 2), 'rec:QQ-Group:1:000002');
        assert.equal(blobKey('QQ-Group:1', 7, 0), 'blob:QQ-Group:1:7:0');
        assert.equal(legacyShardKey('QQ-Group:1', 'raw', 3), 'session_QQ-Group:1:raw:003');
        assert.equal(legacySessionKey('QQ-Group:1'), 'session_QQ-Group:1');
        // 子代理 sessionId 含冒号也应保持可构造（不做解析）
        assert.equal(headKey('sub:QQ-Group:1:2'), 'ctx_head:sub:QQ-Group:1:2');
        assert.equal(eventPageKey('sub:QQ-Group:1:2', 9), 'evt:sub:QQ-Group:1:2:000009');
    },

    testContextV2EventIds() {
        assert.equal(userEventId('m1', 'x'), 'u:m1');
        assert.equal(userEventId('', fallbackEventId('u', 't:1')), 'x:u:t:1');
        assert.equal(assistantEventId('m2', 'x'), 'a:m2');
        assert.equal(toolCallEventId('g1', 'c1'), 'tc:g1:c1');
        assert.equal(toolResultEventId('g1', 'c1'), 'tr:g1:c1');
        assert.equal(systemEventId('recall:1', 'x'), 'e:recall:1');
        // 同一调用/结果 id 不同；不同 group/call 不碰撞
        assert.notEqual(toolCallEventId('g1', 'c1'), toolResultEventId('g1', 'c1'));
        assert.notEqual(toolCallEventId('g1', 'c1'), toolCallEventId('g2', 'c1'));
    },
};
