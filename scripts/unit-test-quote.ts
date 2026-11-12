// 引用回复展开（#163 D6 / REQ-D6-01 ~ D6-12）单测：数据层双写、去重指针、缓存、超时降级、收信接线。
// 对应 exec/d456-content.md E.3 的 T15-1 ~ T15-13（T15-7 渲染属 PR-09，本域不测）。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { ContextService } from '../src/context/service';
import { setHost } from '../src/core/host';
import { serializePendingQueue } from '../src/session/persistence';
import { extractQuoteId, quoteEventId, resetQuoteCacheForTest, resolveQuote, setQuoteOb11TimeoutForTest } from '../src/session/quote';
import type { Session } from '../src/session/session';
import { SessionService } from '../src/session/session_service';

/** 同 context-* 单测的存储桩：缺 key 抛错 + 探测器，让事件页/记录的"缺失"与"损坏"可区分 */
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

/** 安装宿主 + seal.format 桩（图片段归一化会读它；单测不看识图条件，一律 0=不识别） */
function installHost(): FakeStorage {
    const storage = new FakeStorage();
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => Date.now() },
        fetch: (() => { throw new Error('no fetch'); }) as any,
        ext: {} as any,
    });
    (globalThis as any).seal.format = () => '0';
    return storage;
}

/** 打开一个已接入 v2 事件账本的真实会话（SessionService 生产路径） */
function openSession(sid: string): { session: Session; storage: FakeStorage } {
    const storage = installHost();
    const service = new SessionService();
    service.agentName = '*';
    const session = service.getSession(sid);
    session.sessionType = 'user';
    return { session, storage };
}

/** 临时 ctx：私聊、发言人是引用回复的发送者 */
function makeCtx(epId = 'QQ:10000', playerId = 'QQ:123'): seal.MsgContext {
    return {
        endPoint: { userId: epId, platform: 'QQ' },
        player: { userId: playerId, name: '测试员' },
        isPrivate: true,
        group: null,
    } as unknown as seal.MsgContext;
}

/** 临时 msg：segment 显式置空，避免走 milky 的 net.messageId 分支 */
function makeMsg(rawId: number): seal.Message {
    return { rawId, segment: [] } as unknown as seal.Message;
}

interface NetCall { endpointId: string; action: string; params: Record<string, any> }

/** 装一个计数用 ob11 网络桩（ob11_net_backend 直接读 globalThis.net） */
function installCountingNet(handler: (call: NetCall) => any): NetCall[] {
    const calls: NetCall[] = [];
    (globalThis as any).net = {
        callApi: async (endpointId: string, action: string, params: Record<string, any>) => {
            const call = { endpointId, action, params };
            calls.push(call);
            return handler(call);
        },
    };
    return calls;
}

function clearNet(): void {
    delete (globalThis as any).net;
}

/** reply 段用十进制原始 ID（与协议端一致），期望被归一成 base36 短 ID 'abc' */
const DECIMAL_OF_ABC = 13368;

Config.registerConfig();

export const tests: Record<string, () => void | Promise<void>> = {
    /** T15-10 的前半：reply 段解析口径（十进制→base36、非法/空→''） */
    testQuoteExtractQuoteId() {
        assert.equal(quoteEventId('abc'), 'q:abc', '引用事件 id 前缀固定 q:');
        assert.equal(extractQuoteId([] as any), '', '无消息段');
        assert.equal(extractQuoteId([{ type: 'text', data: { text: 'hi' } }] as any), '', '无 reply 段');
        assert.equal(extractQuoteId([{ type: 'reply', data: { id: String(DECIMAL_OF_ABC) } }] as any), 'abc', '十进制应归一为 base36');
        assert.equal(extractQuoteId([{ type: 'reply', data: { id: 'abc' } }] as any), 'abc', '已是短 ID 原样保留');
        assert.equal(extractQuoteId([{ type: 'reply', data: { id: '' } }] as any), '', '空 id 不展开');
        assert.equal(extractQuoteId([{ type: 'reply', data: {} }] as any), '', '缺 id 不展开');
        assert.equal(extractQuoteId([{ type: 'reply', data: { id: 'not a id!' } }] as any), '', '非法 id 不展开');
    },

    /** T15-1 / T15-12：账本命中 ⇒ 双写且 seq 相邻、只冻结一次、不递归展开、零网络调用 */
    async testQuoteContextHitWritesAdjacentPair() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-hit');
        // 被引原文：文本 + 真 image + 一句"引用回复"的 [quote:x]（后者必须按普通 part 处理，不递归）
        session.contextV2!.appendUser('QQ:123', 'abc', [
            { type: 'text', text: '昨天在公园拍的' },
            { type: 'image', ref: 'h1' },
            { type: 'quote', id: 'x' },
        ]);
        const calls = installCountingNet(() => ({ message_id: 1, raw_message: '不该走到这里' }));

        await session.handleReceipt(makeCtx(), makeMsg(2001), [
            { type: 'reply', data: { id: String(DECIMAL_OF_ABC) } },
            { type: 'text', data: { text: '这图哪来的' } },
        ] as any);

        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, 3, '原事件 + 引用事件 + 回复事件');
        const quote = events[1] as any;
        const reply = events[2] as any;
        assert.equal(quote.eventId, 'q:abc');
        assert.equal(quote.kind, 'user');
        assert.equal(quote.origin, 'quote');
        assert.equal(quote.quoteOf, 'abc');
        assert.equal(quote.msgId, 'abc');
        assert.equal(quote.uid, 'QQ:123');
        assert.ok(quote.fromName, 'fromName 必须冻结出非空值');
        assert.ok(quote.parts.some((part: any) => part.type === 'image' && part.ref === 'h1'), '被引图片以真 image part 冻结');
        assert.ok(quote.parts.some((part: any) => part.type === 'quote' && part.id === 'x'), '被引消息自带的 [quote:x] 按普通 part 保留');
        assert.equal(reply.seq, quote.seq + 1, '两条事件 seq 必须相邻（同一次 store.append）');
        assert.equal(reply.kind, 'user');
        assert.equal(reply.origin, undefined, '回复事件不是 quote 来源');
        assert.equal(calls.length, 0, 'T15-1：账本命中不得产生任何 ob11 调用');
        clearNet();
    },

    /** T15-2：账本未命中 ⇒ 走 ob11 get_msg，冻结发言人/卡片名/图片 */
    async testQuoteOb11FallbackFillsSenderAndImage() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-ob11');
        const calls = installCountingNet(() => ({
            message_id: DECIMAL_OF_ABC,
            raw_message: '[CQ:image,file=x.jpg] 昨天在公园拍的',
            sender: { user_id: 123, card: '张三' },
        }));

        await session.handleReceipt(makeCtx(), makeMsg(2002), [
            { type: 'reply', data: { id: String(DECIMAL_OF_ABC) } },
            { type: 'text', data: { text: '这图哪来的' } },
        ] as any);

        assert.equal(calls.length, 1, '账本未命中必须只拉一次');
        assert.equal(calls[0].action, 'get_msg');
        assert.equal(calls[0].params.message_id, DECIMAL_OF_ABC, '请求参数必须是原始十进制 message_id');

        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, 2, '引用事件 + 回复事件');
        const quote = events[0] as any;
        assert.equal(quote.eventId, 'q:abc');
        assert.equal(quote.origin, 'quote');
        assert.equal(quote.uid, 'QQ:123', 'sender.user_id 应归一成 UNI-ID');
        assert.equal(quote.fromName, '张三', '优先用卡片名');
        assert.ok(quote.parts.some((part: any) => part.type === 'image'), 'CQ 图片段应转成 image part');
        assert.ok(quote.parts.some((part: any) => part.type === 'text' && part.text.includes('昨天在公园拍的')));
        clearNet();
    },

    /** T15-3：账本无 + get_msg 失败 ⇒ 写占位，只 1 条事件，不抛错 */
    async testQuoteUnavailablePlaceholderNoThrow() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-fail');
        const calls = installCountingNet(() => ({ ok: false, retcode: 1200, message: '消息不存在' }));

        await session.handleReceipt(makeCtx(), makeMsg(2003), [
            { type: 'reply', data: { id: String(DECIMAL_OF_ABC) } },
            { type: 'text', data: { text: '这图哪来的' } },
        ] as any);

        assert.equal(calls.length, 1, '失败也要尝试一次');
        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, 1, '展开失败只写回复事件（不伪造发言人）');
        const reply = events[0] as any;
        assert.equal(reply.kind, 'user');
        assert.equal(reply.quoteOf, undefined, '失败时不得带引用指针');
        assert.equal(reply.parts[0].type, 'unknown');
        assert.equal(reply.parts[0].tag, 'quote_unavailable');
        assert.equal(reply.parts[0].content, 'abc');
        assert.ok(reply.parts.some((part: any) => part.type === 'text' && part.text.includes('这图哪来的')));
        clearNet();
    },

    /** T15-4 / T15-06：同一条被引消息第二次出现 ⇒ 只写回复事件 + quoteOf 指针 */
    async testQuoteSecondReferenceWritesPointerOnly() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-repeat');
        session.contextV2!.appendUser('QQ:123', 'abc', [{ type: 'text', text: '昨天在公园拍的' }]);
        installCountingNet(() => ({ message_id: 1 }));

        const replySeg = [{ type: 'reply', data: { id: 'abc' } }, { type: 'text', data: { text: '第一次引用' } }] as any;
        await session.handleReceipt(makeCtx(), makeMsg(3001), replySeg);
        assert.equal(session.contextV2!.snapshot().events.length, 3, '第一次：原事件 + 引用 + 回复');

        const before = session.contextV2!.snapshot().events.length;
        await session.handleReceipt(makeCtx(), makeMsg(3002), [
            { type: 'reply', data: { id: 'abc' } },
            { type: 'text', data: { text: '第二次引用' } },
        ] as any);
        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, before + 1, '第二次只写回复事件');
        const reply = events[events.length - 1] as any;
        assert.equal(reply.quoteOf, 'abc', '后续引用只加指针');
        const quoteEvents = events.filter((event: any) => event.eventId === 'q:abc');
        assert.equal(quoteEvents.length, 1, '全账本 q:abc 恰好一条');
        clearNet();
    },

    /** T15-5：同一条被引消息 30s 内重复展开（账本与缓存均未命中）只拉一次 */
    async testQuoteCacheServesRepeatedLookups() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-cache');
        const calls = installCountingNet(() => ({
            message_id: 777,
            raw_message: '被引用的原文',
            sender: { user_id: 456 },
        }));
        const ctx = makeCtx();
        const msg = makeMsg(4001);

        const first = await resolveQuote(session, ctx, msg, 'zzz');
        const second = await resolveQuote(session, ctx, msg, 'zzz');
        const third = await resolveQuote(session, ctx, msg, 'zzz');

        assert.equal(calls.length, 1, 'T15-5：30s 缓存内只拉一次');
        assert.ok(first && second && third, '三次都拿到同一份快照');
        assert.equal(first!.uid, 'QQ:456');
        assert.equal(second!.fromName, first!.fromName);
        assert.deepEqual(third!.parts, first!.parts);
        clearNet();
    },

    /** T15-6：协议端永不返回 ⇒ 超时降级为 null（写占位），不抛错 */
    async testQuoteOb11TimeoutDegradesToNull() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-timeout');
        installCountingNet(() => new Promise(() => { /* 永不 resolve */ }));
        setQuoteOb11TimeoutForTest(30);
        const startedAt = Date.now();
        try {
            const draft = await resolveQuote(session, makeCtx(), makeMsg(5001), 'tt');
            assert.equal(draft, null, '超时应降级为 null');
            assert.ok(Date.now() - startedAt < 3000, '必须按注入的短超时返回，不阻塞收信');
        } finally {
            setQuoteOb11TimeoutForTest(null);
            clearNet();
        }
    },

    /** T15-8 / T15-11（REQ-D6-11）：忙态只记 quoteOf 不展开；flushPending 时才展开且 seq 相邻 */
    async testQuoteDeferRecordsIdAndFlushExpands() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-defer');
        session.contextV2!.appendUser('QQ:123', 'abc', [{ type: 'text', text: '昨天在公园拍的' }]);
        const calls = installCountingNet(() => ({ message_id: 1 }));
        session.running = true;

        const ctx = makeCtx();
        const msg = makeMsg(6001);
        await session.deferReceipt(ctx, msg, [
            { type: 'reply', data: { id: 'abc' } },
            { type: 'text', data: { text: '挂起引用' } },
        ] as any, 'record');

        assert.equal(session.pendingQueue.length, 1);
        assert.equal(session.pendingQueue[0].quoteOf, 'abc', '忙态只记被引 msgId');
        assert.equal(calls.length, 0, '忙态不得做网络/IO');
        assert.equal(session.contextV2!.snapshot().events.length, 1, '忙态不入库');

        session.running = false;
        assert.equal(await session.flushPending(), false, 'record 类不触发续跑');
        assert.equal(session.pendingQueue.length, 0);

        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, 3, '原事件 + flush 出的引用/回复两条');
        const quote = events[1] as any;
        const reply = events[2] as any;
        assert.equal(quote.eventId, 'q:abc');
        assert.equal(reply.seq, quote.seq + 1, 'flush 时引用事件紧邻回复事件之前');
        assert.ok(reply.parts.some((part: any) => part.type === 'text' && part.text.includes('挂起引用')));
        clearNet();
    },

    /** T15-9 / T15-10：普通消息与空 reply 段都保持改造前行为（只写 1 条 user 事件） */
    async testQuoteNoReplySegmentRegression() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-plain');
        const calls = installCountingNet(() => ({ message_id: 1 }));

        await session.handleReceipt(makeCtx(), makeMsg(7001), [{ type: 'text', data: { text: '普通消息' } }] as any);
        assert.equal(session.contextV2!.snapshot().events.length, 1, 'T15-9：无 reply 段只 1 条');

        await session.handleReceipt(makeCtx(), makeMsg(7002), [
            { type: 'reply', data: { id: '' } },
            { type: 'text', data: { text: '空引用' } },
        ] as any);
        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, 2, 'T15-10：reply 段无 id 也不展开不写占位');
        const second = events[1] as any;
        assert.equal(second.quoteOf, undefined);
        assert.ok(second.parts.every((part: any) => part.type !== 'unknown'), '不得写占位');
        assert.equal(calls.length, 0, '空引用不产生 ob11 调用');
        clearNet();
    },

    /** T15-11：引用 bot 自己的 assistant 消息 ⇒ 发言人是当前端点 */
    async testQuoteAssistantReference() {
        resetQuoteCacheForTest();
        const { session } = openSession('QQ:quote-assistant');
        session.contextV2!.appendAssistant('robot1', [{ type: 'text', text: '我是机器人' }]);
        const calls = installCountingNet(() => ({ message_id: 1 }));

        await session.handleReceipt(makeCtx(), makeMsg(8001), [
            { type: 'reply', data: { id: 'robot1' } },
            { type: 'text', data: { text: '你刚说什么' } },
        ] as any);

        const events = session.contextV2!.snapshot().events;
        assert.equal(events.length, 3);
        const quote = events[1] as any;
        assert.equal(quote.eventId, 'q:robot1');
        assert.equal(quote.uid, 'QQ:10000', '引用 bot 消息时发言人取当前端点');
        assert.ok(quote.fromName, 'fromName 非空');
        assert.ok(quote.parts.some((part: any) => part.type === 'text' && part.text === '我是机器人'), 'parts 取 assistant 内容');
        assert.equal(calls.length, 0);
        clearNet();
    },

    /** REQ-D6-11：PendingMessage.quoteOf 必须能落盘/读回，旧分片保持"无该字段" */
    testQuotePendingMessageSerializeRoundTrip() {
        const withQuote = [{
            ctx: {}, msg: {}, content: '挂起内容', userId: 'QQ:123', messageId: 'm1',
            kind: 'record', epId: 'QQ:10000', isPrivate: true, quoteOf: 'abc',
        }] as any;
        const parsed = JSON.parse(serializePendingQueue(withQuote));
        assert.equal(parsed[0].quoteOf, 'abc', '引用指针必须随挂起分片落盘');
        assert.equal(parsed[0].content, '挂起内容');

        const legacy = [{
            ctx: {}, msg: {}, content: '旧内容', userId: 'QQ:123', messageId: 'm2',
            kind: 'record', epId: 'QQ:10000', isPrivate: false,
        }] as any;
        const parsedLegacy = JSON.parse(serializePendingQueue(legacy));
        assert.equal(Object.prototype.hasOwnProperty.call(parsedLegacy[0], 'quoteOf'), false, '旧分片不应凭空产生字段');
    },

    /** T15-13：新字段（origin/fromName/quoteOf）落盘后不触发页校验失败，重开可读回 */
    async testQuoteEventPageValidatesAfterReopen() {
        resetQuoteCacheForTest();
        const sid = 'QQ:quote-persist';
        const { session } = openSession(sid);
        await session.context.addUserMessageWithQuote(makeCtx(), '[quote:abc] 回复内容', 'QQ:123', 'reply1', {
            msgId: 'abc',
            uid: 'QQ:123',
            fromName: '张三',
            parts: [{ type: 'text', text: '被引用的原文' }],
        });
        assert.equal((await session.contextV2!.flush()).ok, true, '含新字段的事件页必须能落盘');

        const reopened = await ContextService.open(sid);
        const events = reopened.snapshot().events;
        assert.equal(events.length, 2, '重开后引用 + 回复都在');
        const quote = events[0] as any;
        assert.equal(quote.eventId, 'q:abc');
        assert.equal(quote.origin, 'quote');
        assert.equal(quote.fromName, '张三');
        assert.equal(quote.quoteOf, 'abc');
        assert.equal(quote.uid, 'QQ:123');
        const reply = events[1] as any;
        assert.equal(reply.eventId, 'u:reply1');
        assert.ok(reply.parts.some((part: any) => part.type === 'quote' && part.id === 'abc'));
    },
};
