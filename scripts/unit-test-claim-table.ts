// M2 单测：认领表（pipeline/claim_table）。
import assert from 'node:assert/strict';

import { ClaimTable, CLAIM_TTL_MS, eventClaimKey, messageClaimKey } from '../src/pipeline/claim_table';

export const tests = {
    testClaimKeyShape(): void {
        assert.equal(messageClaimKey('QQ-Group:1', 123), 'msg:QQ-Group:1:123');
        assert.equal(eventClaimKey('poke|ep|sid'), 'evt:poke|ep|sid');
    },

    testClaimAndRelease(): void {
        let now = 1000;
        const table = new ClaimTable({ ttlMs: 1000, now: () => now });
        table.claim('s1', 'msg:s1:1', 'mode');
        assert.equal(table.hasClaim('s1', 'msg:s1:1'), true);
        assert.equal(table.ownerOf('s1', 'msg:s1:1'), 'mode');
        assert.equal(table.release('s1', 'msg:s1:1'), true);
        assert.equal(table.hasClaim('s1', 'msg:s1:1'), false);
        assert.equal(table.release('s1', 'msg:s1:1'), false);
    },

    testClaimTtlExpiry(): void {
        let now = 1000;
        const table = new ClaimTable({ ttlMs: 1000, now: () => now });
        table.claim('s1', 'k', 'chain-pending');
        now += 999;
        assert.equal(table.hasClaim('s1', 'k'), true);
        now += 2;
        assert.equal(table.hasClaim('s1', 'k'), false);
    },

    testSessionBucketsIsolated(): void {
        const table = new ClaimTable({ ttlMs: 5000 });
        table.claim('s1', 'same', 'mode');
        assert.equal(table.hasClaim('s1', 'same'), true);
        assert.equal(table.hasClaim('s2', 'same'), false);
        assert.equal(table.hasClaimForSession('s1'), true);
        assert.equal(table.hasClaimForSession('s2'), false);
    },

    testSessionClaimAfterExpiry(): void {
        let now = 0;
        const table = new ClaimTable({ ttlMs: 10, now: () => now });
        table.claim('s1', 'a', 'chain');
        assert.equal(table.hasClaimForSession('s1'), true);
        now = 11;
        assert.equal(table.hasClaimForSession('s1'), false);
    },

    testReleaseSessionAndClear(): void {
        const table = new ClaimTable({ ttlMs: CLAIM_TTL_MS });
        table.claim('s1', 'a', 'mode');
        table.claim('s2', 'b', 'chain');
        assert.equal(table.size, 2);
        assert.equal(table.releaseSession('s1'), 1);
        assert.equal(table.size, 1);
        assert.equal(table.clearAll(), 1);
        assert.equal(table.size, 0);
    },

    testPrune(): void {
        let now = 0;
        const table = new ClaimTable({ ttlMs: 10, now: () => now });
        table.claim('s1', 'a', 'mode');
        table.claim('s1', 'b', 'mode');
        now = 11;
        assert.equal(table.prune(), 2);
        assert.equal(table.size, 0);
    },

    testReclaimRefreshesTtl(): void {
        let now = 0;
        const table = new ClaimTable({ ttlMs: 10, now: () => now });
        table.claim('s1', 'a', 'chain');
        now = 9;
        table.claim('s1', 'a', 'chain-pending');
        now = 15;
        assert.equal(table.hasClaim('s1', 'a'), true);
        assert.equal(table.ownerOf('s1', 'a'), 'chain-pending');
    },
};
