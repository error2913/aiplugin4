// 增量注入契约单测（#163 D3a/D3b 的 T6/T7/T11 组）：
// 渲染位置（`slot`/`clampAnchor`/`effectiveAnchor`/`compareBlocks`）、去重判定（`classifyItem`/`classifyItems`）、
// 去重索引 memo（`activeIndexFor`/`activeIndexKeyOf`）、释放 token 扣减（`releasedInjectTokens`）。
//
// 为什么单独一个 bundle：这些全是**纯函数契约**，不需要 Session / agent / 网络装配；
// 独立入口让 T6-2 这类「写 `>=` 就会红」的反例回归能被最快定位。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import {
    activeIndexFor,
    activeIndexKeyOf,
    buildActiveIndex,
    classifyItem,
    classifyItems,
    resetActiveIndexCache,
} from '../src/context/injection_dedup';import type { ActiveIndex } from '../src/context/injection_dedup';
import {
    activeInjectTokens,
    clampAnchor,
    compareBlocks,
    effectiveAnchor,
    fnv1a32,
    INJECTION_WRAP_TOKENS,
    injectionEventId,
    injectionOf,
    isInjection,
    isReleased,
    kindRank,
    releasedInjectTokens,
    releaseBoundaryOf,
    resetInjectionTokenCache,
    slot,
    splitInjections,
    DEFAULT_KIND_RANK,
} from '../src/context/injections';
import type { InjectionItem, InjectionMeta } from '../src/context/injections';
import type { EventInput } from '../src/context/events';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { ContextService } from '../src/context/service';
import {
    clampToPerTurnBudget,
    classifyDrafts,
    coldStartCap,
    EXTENSION_INJECTION_MAX_CHARS,
    mergeDraftsByKind,
    writeInjectionBlocks,
} from '../src/context/injection_writer';
import type { InjectionWriteDeps } from '../src/context/injection_writer';
import { INJECT_COLD_START_MAX_TOKENS, INJECT_PER_TURN_MAX_TOKENS } from '../src/utils/context_limits';
import { makeItem } from '../src/prompt/injections/keys';

class FakeStorage {
    map = new Map<string, string>();
    get(key: string): string {
        if (!this.map.has(key)) throw new Error(`key not found: ${key}`);
        return this.map.get(key)!;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

function installHost(): void {
    const storage = new FakeStorage();
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => Date.now() },
        fetch: (() => { throw new Error('no fetch in unit test'); }) as any,
        ext: {} as any,
    });
}

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

/** 只取 `toSeq` 的最小单元形状（`slot` 的入参只需要它） */
function unit(toSeq: number): { toSeq: number } {
    return { toSeq };
}

function head(nextSeq: number, archivedThrough = 0): { nextSeq: number; archivedThrough: number } {
    return { nextSeq, archivedThrough };
}

function item(key: string, text: string, refSeq?: number): InjectionItem {
    return makeItem(key, text, refSeq);
}

function metaOf(kind: string, afterSeq: number, items: InjectionItem[]): InjectionMeta {
    return {
        v: 1,
        kind,
        afterSeq,
        tokens: items.reduce((n, it) => n + it.text.length, 0) + INJECTION_WRAP_TOKENS,
        items,
        createdAt: 1,
    };
}

/** 造一个"注入块事件"（结构子集即可，纯函数只读这几个字段） */
function injectionEvent(seq: number, kind: string, afterSeq: number, items: InjectionItem[]) {
    return {
        // 注入块载体是 `kind:'event'` 的 SystemEvent + `raw.injection`（不新增 event kind）
        kind: 'event' as const,
        seq,
        at: seq,
        systemName: `inject-${kind}`,
        raw: { injection: metaOf(kind, afterSeq, items) },
        parts: [{ type: 'text' as const, text: items.map(i => i.text).join('\n') }],
    };
}

function emptyIndex(): ActiveIndex {
    return { byKey: new Map(), byText: new Map(), releasedKeys: new Map() };
}

function indexOf(opts: { byKey?: [string, number][]; byText?: [number, string][]; releasedKeys?: [string, number][] }): ActiveIndex {
    return {
        byKey: new Map(opts.byKey ?? []),
        byText: new Map(opts.byText ?? []),
        releasedKeys: new Map(opts.releasedKeys ?? []),
    };
}

// ---------------------------------------------------------------------------
// 写入口 harness（T9）
// ---------------------------------------------------------------------------

let sidCounter = 0;

interface WriterHarness {
    service: ContextService;
    deps: InjectionWriteDeps;
    budget: { prefixTokens: number; toolsReserveTokens: number; permanentBudget: number; retainPercent: number };
    beforeRequestCalls: () => number;
}

/**
 * 极简写入口 harness：假 `estimateT` / 假 `beforeRequest`，只驱动 `writeInjectionBlocks` 的
 * 分支判定。归档的**真实**行为由 `unit-test-context-archive-controller.ts` 覆盖，这里只关心
 * "预算闸是否被调用、归档后 anchor 是否用新水位"。
 */
function makeWriterHarness(opts: { T: number; L: number; archiveAdvances: number }): WriterHarness {
    installHost();
    sidCounter += 1;
    const service = ContextService.openSync(`QQ-Group:inject-writer-${sidCounter}`, {
        estimateEventTokens: () => 10,
    });
    // 必须让 `head.nextSeq > 1`：空会话里 `clampAnchor(0, 1, 0)` 会得到 afterSeq=0，
    // 而 `releaseBoundaryOf` 也是 0 ⇒ `isReleased(0, 0)` 为真，块立刻"已释放"（纯退化场景）。
    const seed = Math.max(2, opts.archiveAdvances + 2);
    const events: EventInput[] = [];
    for (let i = 1; i <= seed; i++) {
        events.push(i % 2 === 1
            ? { kind: 'user', uid: 'QQ:1', msgId: `w${i}`, parts: [{ type: 'text', text: `消息${i}` }] } as EventInput
            : { kind: 'assistant', msgId: `wa${i}`, parts: [{ type: 'text', text: `回复${i}` }] } as EventInput);
    }
    service.getStore().append(events);

    let T = opts.T;
    let calls = 0;
    const deps: InjectionWriteDeps = {
        service,
        archive: {
            estimateT: () => T,
            beforeRequest: () => {
                calls++;
                // 模拟硬切：水位推进后 T 下降
                if (opts.archiveAdvances > 0) {
                    const head = service.head();
                    service.commitArchive(Math.min(head.nextSeq - 1, head.archivedThrough + opts.archiveAdvances));
                    T = Math.max(0, T - opts.archiveAdvances * 10);
                }
            },
        },
        estimateTokens: (text: string) => text.length,
        computeL: () => opts.L,
    };
    return {
        service,
        deps,
        budget: {
            prefixTokens: 0,
            toolsReserveTokens: 0,
            permanentBudget: opts.L,
            retainPercent: 30,
        },
        beforeRequestCalls: () => calls,
    };
}

export const tests: Record<string, () => void | Promise<void>> = {
    // -----------------------------------------------------------------------
    // T6 渲染位置
    // -----------------------------------------------------------------------

    /**
     * T6-1 / T6-2：`slot` 必须用**严格大于** `toSeq > anchor`。
     *
     * 写成 `>=` 会把"上一轮刚发完的最后一条"当成未发送 ⇒ 块插到它前面
     * ⇒ 已发送前缀的字节顺序改变 ⇒ R1 每轮必坏（d3b REQ-D3-22 反例 1）。
     */
    testInjectionSlotIsStrictlyGreaterThanAnchor() {
        const units = [unit(1), unit(2), unit(3)];
        assert.equal(slot({ afterSeq: 2 }, units, head(4)), 2, 'anchor=2 ⇒ 前两个单元已发送，插在下标 2');
        // 反例：若实现误写 `>=`，anchor=2 会得到 1 —— 这行断言就是防回归锁
        assert.notEqual(slot({ afterSeq: 2 }, units, head(4)), 1, '写成 >= 会插到已发送区中间（R1 破裂）');
        assert.equal(slot({ afterSeq: 0 }, units, head(4)), 0, 'anchor=0 ⇒ 插最前');
        assert.equal(slot({ afterSeq: 3 }, units, head(4)), 3, 'anchor 已到最后 ⇒ 插末尾（主路径）');
        assert.equal(slot({ afterSeq: 99 }, units, head(4)), 3, 'anchor 超上界被夹到 nextSeq-1 ⇒ 仍插末尾');
    },

    /**
     * T6-3：合并单元场景 —— anchor 落在"两条相邻 user"之间时，`slot` 必须给 1（而不是 0）。
     *
     * 这是 D2 是否真的落地的探针：若 `segmentUnits` 不带 `anchorSeq`，这两条 user 会合并成
     * 一个 `toSeq=2` 的单元，`slot({afterSeq:1})` 就会返回 0（块被插到已发送内容**前面** ⇒ R1 破）。
     */
    testInjectionSlotHandlesMergedUnit() {
        // D2 生效后：跨 anchor 不合并 ⇒ 两个独立单元 [toSeq=1][toSeq=2]
        assert.equal(slot({ afterSeq: 1 }, [unit(1), unit(2)], head(3)), 1, '第一个单元已发送 ⇒ 插在它之后');
        // 反例：合并成一个单元（D2 缺失）时会是 0 —— 这行断言就是探针
        assert.equal(slot({ afterSeq: 1 }, [unit(2)], head(3)), 0, '合并单元未完全发送 ⇒ 块必须插在它之前（不能劈）');
        assert.equal(slot({ afterSeq: 2 }, [unit(1), unit(2)], head(3)), 2);
    },

    /** T6-4：同一 anchor 上多块 ⇒ 先按 kind rank（time < memory < mcp），再按 seq */
    testInjectionBlockRenderOrderByKindRank() {
        assert.ok(kindRank('time') < kindRank('memory'), 'time 必须排最前');
        assert.ok(kindRank('memory') < kindRank('mcp'), 'memory 在 mcp 前');
        assert.equal(kindRank('ext:smoke:test'), DEFAULT_KIND_RANK, '未登记 kind 排最后');
        assert.equal(kindRank('wake'), DEFAULT_KIND_RANK, 'wake 不是注入块 kind，按默认排');

        const blocks = [
            { kind: 'mcp', seq: 7 },
            { kind: 'time', seq: 5 },
            { kind: 'memory', seq: 6 },
        ];
        const sorted = blocks.slice().sort(compareBlocks);
        assert.deepEqual(sorted.map(b => b.kind), ['time', 'memory', 'mcp']);
        // 同 rank 内按 seq（写入顺序）稳定
        assert.deepEqual(
            [{ kind: 'ext:a', seq: 9 }, { kind: 'ext:b', seq: 8 }].sort(compareBlocks).map(b => b.seq),
            [8, 9],
        );
    },

    /** T6-5：`clampAnchor` 幂等（重放/并发快照下反复夹紧不得漂移） */
    testInjectionClampAnchorIdempotent() {
        const h = head(10);
        // archivedThrough 取值必须在 [0, nextSeq-1] 内（脏数据见下一个断言）
        for (const archivedThrough of [0, 3, 9]) {
            const hh = { ...h, archivedThrough };
            const once = clampAnchor(3, hh.nextSeq, hh.archivedThrough);
            const twice = clampAnchor(once, hh.nextSeq, hh.archivedThrough);
            assert.equal(twice, once, `archivedThrough=${archivedThrough} 时必须幂等`);
            assert.ok(once >= archivedThrough, '锚点不得落在已归档区（否则新块立刻被释放）');
            assert.ok(once <= h.nextSeq - 1, '锚点不得指向未来');
        }
        // 脏数据：水位越过 nextSeq-1 时，上界优先（宁可少算也不能指向未来）
        assert.equal(clampAnchor(3, 10, 99), 9, '上界夹紧优先于水位下界');
        assert.equal(effectiveAnchor(3, h), clampAnchor(3, h.nextSeq, h.archivedThrough), 'effectiveAnchor 与 clampAnchor 同口径');
        assert.equal(effectiveAnchor(3, null), 0, '缺 head 时按 nextSeq=1 夹紧 ⇒ 上界 0（不能指向未来）');
    },

    /**
     * T6-6：脏序（工具组 `toSeq` 越过后续单元的 `seq`）下，`slot` 只按传入单元序推进，
     * 不会因为 seq 回退而插进组内部。
     */
    testInjectionSlotNeverSplitsToolGroup() {
        // 工具组 fromSeq=5 toSeq=9（晚到结果），随后 user(seq 6) —— seq 回退但单元在后
        const units = [unit(9), unit(6)];
        // anchor=5 ⇒ 工具组 toSeq=9 > 5 ⇒ 插在下标 0（组前），绝不劈开组
        assert.equal(slot({ afterSeq: 5 }, units, head(10)), 0);
        // anchor=9 ⇒ 组已发送，user(6) 的 toSeq=6 <= 9 也算已发送 ⇒ 末尾
        assert.equal(slot({ afterSeq: 9 }, units, head(10)), 2);
    },

    // -----------------------------------------------------------------------
    // T7 去重判定
    // -----------------------------------------------------------------------

    /** T7-1 ~ T7-4：四个基本分支 */
    testInjectionClassifyItemBranches() {
        assert.equal(classifyItem(item('a', 'x'), indexOf({ byKey: [['a', item('a', 'x').r]] })), 'dup', 'T7-1 同 k 同 r ⇒ dup');
        assert.equal(classifyItem(item('a', 'y'), indexOf({ byKey: [['a', item('a', 'x').r]] })), 'updated', 'T7-2 同 k 不同 r ⇒ updated');
        assert.equal(
            classifyItem(item('b', 'x'), indexOf({ byText: [[item('a', 'x').h, 'a']] })),
            'dup-text',
            'T7-3 不同 k 同文 ⇒ dup-text（跨 bank 同文）',
        );
        assert.equal(
            classifyItem(item('a', 'x'), indexOf({ releasedKeys: [['a', item('a', 'x').r]] })),
            're-inject',
            'T7-4 只在已释放集合里 ⇒ re-inject（归档后重新讲一遍）',
        );
        assert.equal(classifyItem(item('c', 'z'), emptyIndex()), 'new', '都没命中 ⇒ new');
    },

    /** T7 补充：`dup` 优先于 `dup-text`（同 key 命中先返回，不落到正文比较） */
    testInjectionClassifyItemPrefersDupOverDupText() {
        const same = item('a', 'x');
        const idx = indexOf({ byKey: [['a', same.r]], byText: [[same.h, 'other']] });
        assert.equal(classifyItem(same, idx), 'dup', '同 key 命中必须是 dup，不是 dup-text');
    },

    /** T7 补充：`updated` 必须比较**活动块**的 r，不能拿已释放集合的 r 误判 */
    testInjectionClassifyItemUpdatedUsesActiveRevision() {
        const v1 = item('a', 'v1');
        const v2 = item('a', 'v2');
        // 活动块是 v2，已释放集合是 v1 ⇒ 传 v2 应判 dup（不是 updated）
        const idx = indexOf({ byKey: [['a', v2.r]], releasedKeys: [['a', v1.r]] });
        assert.equal(classifyItem(v2, idx), 'dup', '活动块同 r ⇒ dup');
        assert.equal(classifyItem(v1, idx), 'updated', '与活动块不同 r ⇒ updated（优先于 released）');
    },

    /** T7-5：归档推进水位越过块 `afterSeq` 后，同 k 再判定 ⇒ `re-inject`（不是 dup） */
    testInjectionClassifyAfterReleaseIsReinject() {
        const it1 = item('mem|1', '喜欢猫');
        const events = [injectionEvent(2, 'memory', 1, [it1])];
        const boundary0 = releaseBoundaryOf({ summarizedThrough: 0, archivedThrough: 0 });
        const before = buildActiveIndex(splitInjections(events, boundary0).injections, splitInjections(events, boundary0).released, boundary0);
        assert.equal(classifyItem(it1, before), 'dup', '归档前：活动块里有 ⇒ dup');

        // 水位推到 2（越过块 afterSeq=1）⇒ 块 released
        const boundary1 = releaseBoundaryOf({ summarizedThrough: 0, archivedThrough: 2 });
        const split1 = splitInjections(events, boundary1);
        assert.equal(split1.injections.length, 0, '水位越过 afterSeq ⇒ 不再是活动块');
        assert.equal(split1.released.length, 1);
        const after = buildActiveIndex(split1.injections, split1.released, boundary1);
        assert.equal(classifyItem(it1, after), 're-inject', '归档后同 k ⇒ re-inject（否则模型再也看不到它）');
    },

    /**
     * `classifyItems` 四类分组 + `(updated) ` 行首标记 + 同批内重复剔除。
     *
     * 行首标记是**协议的一部分**：模型靠它区分"内容更新"与"归档后重新注入"。
     */
    testInjectionClassifyItemsGroupsAndMarksUpdated() {
        const active = item('a', '旧正文');
        // `dup-text` 的持有者必须是**另一个** k（同 k 会先被 `dup` 分支吃掉）
        const idx = indexOf({ byKey: [['a', active.r]], byText: [[item('z', '重复正文').h, 'z']] });
        const out = classifyItems(
            [item('a', '新正文'), item('b', '重复正文'), item('a', '新正文'), item('c', '全新'), item('c', '全新重复')],
            idx,
        );
        // 'a' 第一次 updated、第二次同批重复被剔除；'b' dup-text；'c' new，第二次同批重复剔除
        assert.deepEqual(out.verdicts, ['updated', 'new']);
        assert.equal(out.updated, 1);
        assert.equal(out.fresh, 1);
        assert.equal(out.skipped, 3, 'dup-text 1 + 同批重复 2');
        assert.ok(out.items[0].text.startsWith('(updated) '), 'updated 条目必须带行首标记');
        assert.equal(out.items[1].text, '全新');
        // 重复调用不会叠加标记
        const again = classifyItems([{ ...out.items[0] }], emptyIndex());
        assert.equal(again.items[0].text, '新正文', '已带标记的正文再判 new 时要剥掉标记（不叠加）');
    },

    /** `splitInjections`：注入块永不进 conversation（否则会被当历史单元渲染/摘要） */
    testInjectionSplitKeepsBlocksOutOfConversation() {
        const plain = { kind: 'user', seq: 1, at: 1, parts: [{ type: 'text', text: '你好' }] };
        const block = injectionEvent(2, 'time', 1, [item('time:2', 'Current time: 2026-11-12')]);
        const split = splitInjections([plain, block], 0);
        assert.equal(split.conversation.length, 1, '会话事件只留非注入块');
        assert.equal(split.injections.length, 1);
        assert.equal(split.injections[0].meta.kind, 'time');
        assert.equal(isInjection(block), true);
        assert.equal(isInjection(plain), false);
        assert.equal(injectionOf(plain), null);
        assert.equal(injectionOf(null), null);
    },

    /** `injectionEventId` 确定性：同 kind + 同 anchor + 同 items ⇒ 同 id（同 run 内二次写被去重） */
    testInjectionEventIdIsDeterministic() {
        const a = [item('k1', 'x'), item('k2', 'y')];
        const b = [item('k2', 'y'), item('k1', 'x')];   // 顺序不同但集合相同
        assert.equal(injectionEventId('memory', 3, a), injectionEventId('memory', 3, b), 'items 排序后同指纹');
        assert.notEqual(injectionEventId('memory', 3, a), injectionEventId('time', 3, a), 'kind 不同必须不同 id');
        assert.notEqual(injectionEventId('memory', 3, a), injectionEventId('memory', 4, a), 'anchor 不同必须不同 id');
        assert.ok(injectionEventId('memory', 3, a).startsWith('e:inj:memory:3:'), 'id 结构可读');
    },

    /** `isReleased` / `releaseBoundaryOf`：水位取 `max(summarized, archived)` */
    testInjectionReleaseBoundaryIsMax() {
        assert.equal(releaseBoundaryOf({ summarizedThrough: 5, archivedThrough: 3 }), 5);
        assert.equal(releaseBoundaryOf({ summarizedThrough: 3, archivedThrough: 5 }), 5);
        assert.equal(releaseBoundaryOf(null), 0);
        assert.equal(releaseBoundaryOf({ summarizedThrough: -1, archivedThrough: Number.NaN }), 0, '脏值收敛到 0');
        const meta = metaOf('time', 5, [item('time:5', 'x')]);
        assert.equal(isReleased(meta, 5), true, 'afterSeq <= 水位 ⇒ 已释放');
        assert.equal(isReleased(meta, 4), false);
        assert.equal(isReleased(meta, Number.NaN), false, '脏水位按 0 处理');
    },

    // -----------------------------------------------------------------------
    // T11 memo 与 token 扣减
    // -----------------------------------------------------------------------

    /**
     * T11-1 / T11-2：memo 键是 **(块数, 最大 seq, 释放水位)**，不是 `store.version`。
     *
     * `commitArchive` 每次 `version++`，但绝大多数轮次没有块被释放 ⇒ 用 version 作键会 64 轮
     * 一次都命不中（AUDIT-003）。这里直接锁住"三个分量不变 ⇒ 命中"。
     */
    testInjectionActiveIndexMemoKeyedByShape() {
        installHost();
        resetActiveIndexCache();
        const it1 = item('a', 'x');
        const events = [injectionEvent(2, 'memory', 1, [it1])];
        const boundary = 0;
        const split = splitInjections(events, boundary);
        const key = activeIndexKeyOf(split.injections, split.released, boundary);

        const first = activeIndexFor(split.injections, split.released, key);
        assert.deepEqual(activeIndexFor(split.injections, split.released, { ...key }), first, '同键必须返回同一索引');
        assert.equal(first.byKey.get('a'), it1.r);

        // 只有 boundary 变（归档释放了块）⇒ 必须重建（split 与 boundary 必须同源，否则两边口径不一致）
        const split2 = splitInjections(events, 2);
        const next = activeIndexFor(split2.injections, split2.released, { ...key, boundary: 2 });
        assert.notEqual(next, first, 'boundary 变 ⇒ 必须 miss（否则归档后仍判 dup）');
        assert.equal(next.byKey.size, 0, '块已释放 ⇒ 不进活动集合');
        assert.equal(next.releasedKeys.get('a'), it1.r, '但必须进 releasedKeys（供 re-inject）');
        resetActiveIndexCache();
    },

    /** `activeIndexKeyOf` 三个分量的口径（块数含已释放块、maxSeq 取最大、boundary 取整非负） */
    testInjectionActiveIndexKeyShape() {
        const it1 = item('a', 'x');
        const events = [
            injectionEvent(2, 'memory', 1, [it1]),
            injectionEvent(7, 'time', 6, [item('t:7', 'now')]),
        ];
        const split = splitInjections(events, 3);   // afterSeq=1 的块已释放
        const key = activeIndexKeyOf(split.injections, split.released, 3.9);
        assert.equal(key.injectionCount, 2, '块数含已释放块（否则释放时计数不变 ⇒ 误判命中）');
        assert.equal(key.injectionMaxSeq, 7);
        assert.equal(key.boundary, 3, '水位向下取整');
    },

    /** T11-4：`releasedInjectTokens` 只算"本轮由活动变释放"的块 */
    testInjectionReleasedTokensOnlyCountsCrossedBlocks() {
        const events = [
            injectionEvent(2, 'memory', 2, [item('a', 'x'.repeat(10))]),
            injectionEvent(5, 'time', 5, [item('b', 'y'.repeat(20))]),
            injectionEvent(9, 'mcp', 9, [item('c', 'z'.repeat(30))]),
        ];
        const second = injectionOf(events[1])!;
        assert.equal(
            releasedInjectTokens(events, 4, 8),
            second.tokens,
            '水位 4→8 只跨过 afterSeq=5 的块（afterSeq=2 早就释放、afterSeq=9 还没）',
        );
        assert.equal(releasedInjectTokens(events, 0, 2), injectionOf(events[0])!.tokens, '0→2 跨过第 1 块');
        assert.equal(releasedInjectTokens(events, 8, 8), 0, '水位没动 ⇒ 0');
        assert.equal(releasedInjectTokens(events, 8, 4), 0, '反向区间 ⇒ 0（不返回负数）');
    },

    /** `activeInjectTokens` 与 `estimateT` 的第三项同口径（AUDIT-002：唯一实现） */
    testInjectionActiveTokensMatchBoundary() {
        installHost();
        resetInjectionTokenCache();
        const events = [
            injectionEvent(2, 'memory', 2, [item('a', 'x'.repeat(10))]),
            injectionEvent(5, 'time', 5, [item('b', 'y'.repeat(20))]),
        ];
        const all = injectionOf(events[0])!.tokens + injectionOf(events[1])!.tokens;
        assert.equal(activeInjectTokens(events as any, { summarizedThrough: 0, archivedThrough: 0 }), all);
        assert.equal(
            activeInjectTokens(events as any, { summarizedThrough: 0, archivedThrough: 4 }),
            injectionOf(events[1])!.tokens,
            '水位 4 ⇒ afterSeq=2 的块已释放（<= 水位），afterSeq=5 的仍活动',
        );
        assert.equal(
            activeInjectTokens(events as any, { summarizedThrough: 0, archivedThrough: 5 }),
            0,
            '水位 5 ⇒ afterSeq=5 也算已释放（`isReleased` 是 <=）',
        );
        assert.equal(activeInjectTokens(events as any, { summarizedThrough: 9, archivedThrough: 9 }), 0);
        resetInjectionTokenCache();
    },

    /** T11-5：`fnv1a32` 是稳定 32 位哈希（脏数据/中文/空串都不越界） */
    testInjectionHashStable() {
        assert.equal(fnv1a32(''), 0x811c9dc5, '空串 = 初值');
        assert.equal(fnv1a32('abc'), fnv1a32('abc'));
        assert.notEqual(fnv1a32('abc'), fnv1a32('abd'));
        for (const text of ['喜欢猫', 'a'.repeat(1000), '\u0000\u{1F600}']) {
            const h = fnv1a32(text);
            assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `哈希必须落在 uint32（${text.slice(0, 8)}）`);
        }
        resetActiveIndexCache();
    },

    // -----------------------------------------------------------------------
    // T9 写入口（D3a 骨架 + D3b 预算/额度）
    // -----------------------------------------------------------------------

    /** 同 kind 多 draft 合并成一个块；不同 kind 各成一块（REQ-D3-05） */
    testInjectionWriterMergeByKind() {
        const merged = mergeDraftsByKind([
            { kind: 'memory', items: [item('m1', 'a')] },
            { kind: 'time', items: [item('t1', 'b')] },
            { kind: 'memory', items: [item('m2', 'c')], extension: true },
        ]);
        assert.equal(merged.length, 2, '两个 kind ⇒ 两块');
        const memory = merged.find(d => d.kind === 'memory') as RawInjectionDraft;
        assert.equal(memory.items.length, 2, '同 kind 条目合并');
        assert.equal(memory.extension, true, '任一 draft 是扩展块 ⇒ 合并后仍是扩展块（受 2000 字符上限）');
        assert.equal(merged.find(d => d.kind === 'time')!.items.length, 1);
    },

    /** 去重后按**实际条目**重算 tokens（含 `INJECTION_WRAP_TOKENS`，I-06 三处同口径） */
    testInjectionWriterClassifyDraftsRecountsTokens() {
        const index = emptyIndex();
        const { drafts, duplicates } = classifyDrafts(
            [{ kind: 'memory', items: [item('m1', 'abc'), item('m2', 'de')] }],
            index,
            text => text.length,
        );
        assert.equal(drafts.length, 1);
        assert.equal(duplicates, 0);
        assert.equal(drafts[0].tokens, INJECTION_WRAP_TOKENS + 3 + 2, 'tokens = 正文 + 包装');

        // 全部 dup ⇒ 不产 draft（但**不是**跳注，duplicates 计数）
        const it = item('m1', 'abc');
        const dup = classifyDrafts(
            [{ kind: 'memory', items: [it] }],
            indexOf({ byKey: [['m1', it.r]] }),
            text => text.length,
        );
        assert.equal(dup.drafts.length, 0, '全是 dup ⇒ 无 draft');
        assert.equal(dup.duplicates, 1);
    },

    /**
     * T9-6：单轮额度按**条目**累加，且**绝不截断条目正文**。
     *
     * 截断会让同一 `k` 的 `r` 与完整正文哈希不一致 ⇒ 下一轮判 `updated` ⇒ 无限重写（d3b G.2）。
     */
    testInjectionWriterClampToPerTurnBudget() {
        const drafts = [{
            kind: 'memory',
            items: [item('a', 'x'.repeat(300)), item('b', 'y'.repeat(300)), item('c', 'z'.repeat(300))],
            tokens: 900,
        }];
        const kept = clampToPerTurnBudget(drafts, 512, text => text.length);
        assert.equal(kept.length, 1);
        assert.equal(kept[0].items.length, 1, '前两条装得下一条（300 + 300 > 512）');
        assert.equal(kept[0].items[0].text.length, 300, '正文不得被截断');

        // 单条目自身超上限时也必须写入（否则它永远写不进去）
        const big = clampToPerTurnBudget(
            [{ kind: 'memory', items: [item('big', 'x'.repeat(2000))], tokens: 2000 }],
            512,
            text => text.length,
        );
        assert.equal(big[0].items.length, 1, '单条超上限必须单独成批写入，不得丢弃');
        assert.equal(big[0].items[0].text.length, 2000);
    },

    /** 冷启动上限：活动块为空时放宽到 4×单轮，但不超过 `INJECT_COLD_START_MAX_TOKENS` */
    testInjectionWriterColdStartCap() {
        assert.equal(coldStartCap(0), Math.max(INJECT_PER_TURN_MAX_TOKENS, Math.min(INJECT_COLD_START_MAX_TOKENS, INJECT_PER_TURN_MAX_TOKENS * 4)));
        assert.equal(coldStartCap(0), INJECT_COLD_START_MAX_TOKENS, '512×4 = 2048 恰好等于冷启动上限');
        assert.equal(coldStartCap(100), INJECT_PER_TURN_MAX_TOKENS, '有活动块 ⇒ 回到单轮上限');
    },

    /**
     * T9-3：全部条目 `dup` ⇒ **不写块、不归档**，`skipped` 恒为 0。
     *
     * "内容已在活动块里"不是跳注 —— 这是硬约束（禁止跳注）的唯一合法例外。
     */
    async testInjectionWriterAllDupWritesNothing() {
        const h = makeWriterHarness({ T: 0, L: 10000, archiveAdvances: 0 });
        const it = item('mem|1', '喜欢猫');
        // afterSeq 必须 ≥ 1：`isReleased` 是 `afterSeq <= 水位`，而水位为 0 时 afterSeq=0 会被
        // 判为"已释放"（真实链路里 anchor 恒 ≥ 1，因为种子事件已占 seq 1..n）
        h.service.appendInjection({ kind: 'memory', afterSeq: 1, items: [it] });
        const before = h.service.snapshot().events.length;
        const result = await writeInjectionBlocks({
            deps: h.deps,
            drafts: [{ kind: 'memory', items: [it] }],
            lastSentSeq: 1,
            budget: h.budget,
        });
        assert.equal(result.blocks, 0, '全 dup ⇒ 不写块');
        assert.equal(result.duplicates, 1);
        assert.equal(result.skipped, 0, '真正的跳注数必须恒为 0');
        assert.equal(result.archived, false, '全 dup 不该触发归档');
        assert.equal(h.service.snapshot().events.length, before, '事件数不变');
        assert.equal(h.beforeRequestCalls(), 0);
    },

    /**
     * T9-1 / T9-2：预算闸 —— `T + tokens >= L` 才归档，且**归档只调一次** `beforeRequest`。
     *
     * 归档后 anchor 必须用**新**水位重算，否则新块立刻被释放（等于没注入）。
     */
    async testInjectionWriterEnsuresBudgetBeforeAnchor() {
        // T = 990、L = 1000、draft ≈ 15 ⇒ 必须先归档
        const over = makeWriterHarness({ T: 990, L: 1000, archiveAdvances: 5 });
        const it = item('mem|1', '新记忆');
        const result = await writeInjectionBlocks({
            deps: over.deps,
            drafts: [{ kind: 'memory', items: [it] }],
            lastSentSeq: 1,
            budget: over.budget,
        });
        assert.equal(over.beforeRequestCalls(), 1, 'T + tokens >= L ⇒ 调一次 beforeRequest');
        assert.equal(result.blocks, 1, '归档后仍必须写块（禁止跳注）');
        assert.equal(result.archived, true);
        const written = over.service.snapshot().events.filter(e => isInjection(e));
        assert.equal(written.length, 1);
        assert.equal(
            injectionOf(written[0])!.afterSeq,
            5,
            'anchor 必须用归档后的**新**水位（用旧 lastSentSeq 会让块立刻被释放）',
        );

        // T = 500、L = 1000、draft 300 ⇒ 装得下，不归档
        const room = makeWriterHarness({ T: 500, L: 1000, archiveAdvances: 5 });
        await writeInjectionBlocks({
            deps: room.deps,
            drafts: [{ kind: 'memory', items: [item('mem|1', '新记忆')] }],
            lastSentSeq: 3,
            budget: room.budget,
        });
        assert.equal(room.beforeRequestCalls(), 0, '装得下 ⇒ 不归档');
    },

    /**
     * T9-4：单条自身超 L（切不动）⇒ **仍写块**，只记 `injection-over-budget`。
     *
     * 这正是 REQ-D3-28 的极端兜底：宁可超窗口由 `context_too_long` 兜底，也不能丢注入。
     */
    async testInjectionWriterOverBudgetStillWrites() {
        const h = makeWriterHarness({ T: 9900, L: 10000, archiveAdvances: 0 });
        const events: string[] = [];
        h.deps.observe = (event) => { events.push(event); };
        const result = await writeInjectionBlocks({
            deps: h.deps,
            drafts: [{ kind: 'memory', items: [item('mem|big', 'x'.repeat(12000))] }],
            lastSentSeq: 1,
            budget: h.budget,
        });
        assert.equal(h.beforeRequestCalls(), 1, '超预算要先尝试归档');
        assert.equal(result.blocks, 1, '切不动也必须写块（禁止跳注）');
        assert.equal(result.skipped, 0);
        assert.ok(events.includes('injection-over-budget'), `应记 injection-over-budget（实际 ${JSON.stringify(events)}）`);
    },

    /**
     * T9-8（REQ-D3-28b）：归档后**仍在超预算** ⇒ `updated` 延后到下一轮，
     * `new` / `re-inject` 永不延后（否则模型看不到新事实）。
     */
    async testInjectionWriterDefersUpdatedWhenStillOver() {
        // T = 9990、L = 10000、draft ≈ 19 ⇒ 归档切不动（archiveAdvances=0）⇒ 归档后仍超预算
        const h = makeWriterHarness({ T: 9990, L: 10000, archiveAdvances: 0 });
        const events: string[] = [];
        h.deps.observe = (event) => { events.push(event); };
        const it = item('mem|1', '旧内容');
        h.service.appendInjection({ kind: 'memory', afterSeq: 1, items: [it] });
        const result = await writeInjectionBlocks({
            deps: h.deps,
            drafts: [{ kind: 'memory', items: [item('mem|1', '新内容'), item('mem|2', '全新事实')] }],
            lastSentSeq: 1,
            budget: h.budget,
        });
        const written = h.service.snapshot().events
            .map(e => injectionOf(e))
            .filter((m): m is NonNullable<typeof m> => m !== null)
            .flatMap(m => m.items.map(i => i.k));
        assert.ok(written.includes('mem|2'), 'new 条目永不延后');
        assert.equal(
            result.blocks,
            1,
            '一条块（同 kind 合并）：updated 被剔除后仍写 new',
        );
        assert.ok(events.includes('injection-updated-deferred'), '延后 updated 必须可观测');
    },

    /**
     * 外部插件单块 2000 字符上限（逐条截断，不劈条目结构）。
     *
     * 注意单轮额度先跑（冷启动 2048）：两条之和必须 ≤ 2048 才能都活到扩展块截断这一步，
     * 同时又要 > 2000 才会触发截断 —— 因此 1100 + 940 = 2040。
     */
    async testInjectionWriterClampsExtensionBlock() {
        const h = makeWriterHarness({ T: 0, L: 100000, archiveAdvances: 0 });
        await writeInjectionBlocks({
            deps: h.deps,
            drafts: [{
                kind: 'ext:plug:notes',
                extension: true,
                items: [item('n1', 'a'.repeat(1100)), item('n2', 'b'.repeat(940))],
            }],
            lastSentSeq: 1,
            budget: h.budget,
        });
        const blocks = h.service.snapshot().events.map(e => injectionOf(e)).filter(m => m !== null);
        assert.equal(blocks.length, 1);
        const total = blocks[0]!.items.reduce((n, i) => n + i.text.length, 0);
        assert.equal(total, EXTENSION_INJECTION_MAX_CHARS, `扩展块必须被截到 ${EXTENSION_INJECTION_MAX_CHARS} 字符（实际 ${total}）`);
        assert.equal(blocks[0]!.items.length, 2, '逐条截断，不丢条目（第 2 条 940 → 900）');
        assert.equal(blocks[0]!.items[0].text.length, 1100, '第 1 条完整保留');
        assert.equal(blocks[0]!.items[1].text.length, EXTENSION_INJECTION_MAX_CHARS - 1100);
    },

    /** 单条自身超上限：仍只留一条，但正文被截到上限（不丢弃、不劈成两条） */
    async testInjectionWriterClampsSingleOversizeExtensionItem() {
        const h = makeWriterHarness({ T: 0, L: 100000, archiveAdvances: 0 });
        await writeInjectionBlocks({
            deps: h.deps,
            drafts: [{
                kind: 'ext:plug:huge',
                extension: true,
                items: [item('n1', 'a'.repeat(3000))],
            }],
            lastSentSeq: 1,
            budget: h.budget,
        });
        const blocks = h.service.snapshot().events.map(e => injectionOf(e)).filter(m => m !== null);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0]!.items.length, 1);
        assert.equal(blocks[0]!.items[0].text.length, EXTENSION_INJECTION_MAX_CHARS);
    },

    /** 空 draft / 空 items ⇒ 零成本直接返回（不碰 snapshot） */
    async testInjectionWriterEmptyDraftsNoop() {
        const h = makeWriterHarness({ T: 0, L: 1000, archiveAdvances: 0 });
        const before = h.service.snapshot().events.length;
        const empty = await writeInjectionBlocks({ deps: h.deps, drafts: [], lastSentSeq: 1, budget: h.budget });
        assert.equal(empty.blocks, 0);
        const blank = await writeInjectionBlocks({
            deps: h.deps,
            drafts: [{ kind: 'memory', items: [] }],
            lastSentSeq: 1,
            budget: h.budget,
        });
        assert.equal(blank.blocks, 0);
        assert.equal(h.service.snapshot().events.length, before, '空 draft 不得写任何事件');
        assert.equal(h.beforeRequestCalls(), 0);
    },
};
