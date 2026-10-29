// resolve_context_ref 单测：表示解析、事件/事件 raw、read_raw 指针、内容标签、歧义与错误。
import assert from 'node:assert/strict';

import { ContextService } from '../src/context/service';
import { findEventBySeq } from '../src/context/recall';
import { parseContextRef } from '../src/context/resolve';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import type { Host } from '../src/core/host';
import { setMemoryEngineFactory } from '../src/memory/service';
import { MemoryEngine } from '../src/memory/v2/engine';
import { buildMemoryPrompt } from '../src/memory/v2/prompt';
import { memoryHandle, normalizeMemoryRef } from '../src/memory/v2/ref';
import { InMemoryMemoryStorage } from '../src/memory/v2/storage';
import { registerResolveContextRef } from '../src/tool/tools/context/tool_resolve';
import { toolMap } from '../src/tool/registry';

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

let storage = new FakeStorage();

function installHost(): void {
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage,
        clock: { now: () => 1700000000000 },
        fetch: (() => { throw new Error('no fetch'); }) as unknown as Host['fetch'],
        ext: {} as Host['ext'],
    });
}

async function seed(): Promise<ContextService> {
    storage = new FakeStorage();
    installHost();
    const service = await ContextService.open('QQ-Group:resolve-test');
    service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '第一条消息' }]);
    service.appendSystem({
        systemName: 'group-event',
        eventType: 'group_increase',
        raw: { user_id: 'QQ:2', group_id: 'QQ-Group:resolve-test', type: 'group_increase' },
        parts: [{ type: 'text', text: '新成员加入' }],
    });
    service.appendAssistant('m2', [{ type: 'text', text: '第一条回复' }]);
    assert.equal((await service.flush()).ok, true);
    return service;
}

function makeSession(service: ContextService): any {
    return {
        sessionId: 'QQ-Group:resolve-test',
        sessionType: 'group',
        agentName: '*',
        setting: { priv: 0 },
        contextV2: service,
        context: { messages: [] },
    };
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextResolveParse(): void {
        assert.equal(parseContextRef('e:57').kind, 'event');
        assert.equal(parseContextRef('e:3-40').kind, 'event');
        assert.equal(parseContextRef('[msg_id:3f]').kind, 'message');
        assert.equal(parseContextRef('[quote:3f]').kind, 'message');
        assert.equal(parseContextRef('[mem:abc]').kind, 'memory');
        assert.equal(parseContextRef('event_raw:5').kind, 'event_raw');
        assert.equal(parseContextRef('read_raw kind=user id=m1').kind, 'event');
        assert.equal((parseContextRef('read_raw kind=user id=m1') as any).address, 'm1');
        assert.equal((parseContextRef('[content-compressed: 100 chars; read_raw kind=user id=m2]') as any).address, 'm2');
        assert.equal(parseContextRef('[img:https://example.com/a.png:截图]').kind, 'image');
        assert.equal(parseContextRef('[record:h1]语音[/record]').kind, 'media');
        assert.equal(parseContextRef('[resource:mcp://srv/a.txt|mime=text/plain]').kind, 'resource');
        assert.equal(parseContextRef('[at:QQ:1]').kind, 'message');
        assert.equal(parseContextRef('[face:微笑]').kind, 'face');
        assert.equal(parseContextRef('[markdown]hi[/markdown]').kind, 'text');
        assert.equal(parseContextRef('abc123').ambiguous, true, '裸 ID 应标记歧义');
        assert.equal(parseContextRef('[system:foo]bar[/system]').kind, 'unknown');
        assert.equal(parseContextRef('e:57', 'event_raw').kind, 'event_raw');
    },

    testMemoryRefFormat(): void {
        assert.equal(memoryHandle('abc'), '[mem:abc] ');
        assert.equal(memoryHandle(''), '');
        assert.equal(normalizeMemoryRef('[mem:abc]'), 'abc');
        assert.equal(normalizeMemoryRef('mem:abc'), 'abc');
        assert.equal(normalizeMemoryRef('abc'), 'abc');
    },

    testMemoryPromptUsesHandles(): void {
        const now = Math.floor(Date.now() / 1000);
        const prompt = buildMemoryPrompt([{
            kind: 'user',
            title: 'Bank',
            mentalModels: [{ id: 'mm1', sourceQuery: 'Q', content: '心智模型', updatedAt: now } as any],
            observations: [{ id: 'o1', text: '观察', updatedAt: now, lastSupportedAt: now, status: 'active' } as any],
            recalls: [{ kind: 'fact', unit: { id: 'f1', text: '事实' } as any, score: 1, matchedStrategies: [] }],
        }], 5000);
        assert.ok(prompt.includes('[mem:mm1]'), prompt);
        assert.ok(prompt.includes('[mem:o1]'), prompt);
        assert.ok(prompt.includes('[mem:f1]'), prompt);
    },

    async testFindEventBySeq(): Promise<void> {
        const service = await seed();
        const store = service.getStore();
        const found = findEventBySeq(store, service.snapshot(), 2);
        assert.ok(found.event, '应找到 e:2');
        assert.equal(found.event?.kind, 'event');
        assert.deepEqual(found.event?.raw, { user_id: 'QQ:2', group_id: 'QQ-Group:resolve-test', type: 'group_increase' });
        assert.equal(findEventBySeq(store, service.snapshot(), 999).event, null);
    },

    async testResolveContextRefTool(): Promise<void> {
        const service = await seed();
        registerResolveContextRef();
        const tool = toolMap['resolve_context_ref'];
        assert.ok(tool, 'resolve_context_ref 应已注册');
        const session = makeSession(service);
        const solve = (args: any): Promise<any> => tool.solve({} as any, {} as any, session, args);

        const event = String(await solve({ ref: 'e:1' }));
        assert.ok(event.includes('[resolved kind=event'), event);
        assert.ok(event.includes('[e:1 kind=user'), event);
        assert.ok(event.includes('第一条消息'), event);

        const pointer = String(await solve({ ref: 'read_raw kind=user id=m1' }));
        assert.ok(pointer.includes('第一条消息'), pointer);

        const raw = String(await solve({ ref: 'e:2', kind: 'event_raw' }));
        assert.ok(raw.includes('[resolved kind=event_raw'), raw);
        assert.ok(raw.includes('"type": "group_increase"'), raw);

        const image = String(await solve({ ref: '[img:https://example.com/a.png:截图]' }));
        assert.ok(image.includes('[resolved kind=image'), image);
        assert.ok(image.includes('https://example.com/a.png'), image);

        const quote = String(await solve({ ref: '[quote:m1]' }));
        assert.ok(quote.includes('[resolved kind=message'), quote);
        assert.ok(quote.includes('message_id='), quote);

        const missing = String(await solve({ ref: 'e:999' }));
        assert.ok(missing.includes('[resolve error code=NOT_FOUND'), missing);

        const ambiguous = String(await solve({ ref: 'm1' }));
        assert.ok(ambiguous.includes('[resolve error code=AMBIGUOUS'), ambiguous);
    },

    async testResolveMemoryByHandle(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1700000000 });
        setMemoryEngineFactory(() => engine);
        const bankId = 'group_QQ-Group:resolve-test';
        engine.repository.addUnit(bankId, {
            id: 'testmem1',
            bankId,
            text: '群记忆内容',
            factType: 'world',
            createdAt: 1700000000,
            createdAtSeq: 1,
            updatedAt: 1700000000,
            embedding: [],
            entityIds: [],
            tags: [],
            metadata: {},
            importance: 0.8,
            accessCount: 0,
            lastAccessedAt: 0,
            state: 'valid',
            consolidationState: 'done',
        } as any);

        const service = await seed();
        registerResolveContextRef();
        const tool = toolMap['resolve_context_ref'];
        const out = String(await tool.solve({} as any, {} as any, makeSession(service), { ref: '[mem:testmem1]' }));
        assert.ok(out.includes('[resolved kind=memory/fact'), out);
        assert.ok(out.includes('群记忆内容'), out);
    },
};
