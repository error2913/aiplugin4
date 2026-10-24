// 旧写入 → v2 受控镜像单测：解析/工具配对/孤儿结果/开关默认关闭。
import assert from 'node:assert/strict';

import {
    attachV2Mirror,
    canMirror,
    isV2MirrorEnabled,
    MirrorToolGroups,
    mirrorAssistant,
    mirrorServiceFor,
    mirrorSystem,
    mirrorToolCalls,
    mirrorToolResult,
    mirrorUser,
    setV2MirrorEnabled,
} from '../src/context/mirror';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';

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
        fetch: (() => { throw new Error('no fetch'); }) as any,
        ext: {} as any,
    });
}

async function open(sid: string): Promise<ContextService> {
    installHost();
    return ContextService.open(sid);
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextMirrorDefaultOff() {
        setV2MirrorEnabled(false);
        assert.equal(isV2MirrorEnabled(), false);
        setV2MirrorEnabled(true);
        assert.equal(isV2MirrorEnabled(), true);
        setV2MirrorEnabled(false);
    },

    async testContextMirrorAttachment() {
        const service = await open('QQ:mirror-attach');
        const target = {};
        setV2MirrorEnabled(false);
        attachV2Mirror(target, service);
        assert.equal(mirrorServiceFor(target), service);
        assert.equal(canMirror(target), false, '开关未开不镜像');
        setV2MirrorEnabled(true);
        assert.equal(canMirror(target), true);
        attachV2Mirror(target, null);
        assert.equal(mirrorServiceFor(target), null);
        setV2MirrorEnabled(false);
    },

    async testContextMirrorUserAssistantSystem() {
        const service = await open('QQ:mirror-basic');
        mirrorUser(service, { uid: 'QQ:1', msgId: 'm1', text: '[at:123] 你好', at: 10 });
        mirrorAssistant(service, { msgId: 'a1', text: '收到', reasoning: '思考', at: 11 });
        mirrorSystem(service, { text: '撤回', systemName: '事件', eventType: 'group_recall', raw: { x: 1 }, at: 12 });
        const events = service.snapshot().events;
        assert.equal(events.length, 3);
        const user = events[0] as any;
        assert.ok(user.parts.length > 0);
        assert.ok(JSON.stringify(user.parts).includes('你好'));
        assert.equal((events[1] as any).reasoning, '思考');
        const system = events[2] as any;
        assert.equal(system.systemName, '事件');
        assert.equal(system.eventType, 'group_recall');
    },

    async testContextMirrorToolGroup() {
        const service = await open('QQ:mirror-tool');
        const groups = new MirrorToolGroups();
        const turnId = groups.nextTurnId();
        const mapping = mirrorToolCalls(service, {
            turnId,
            reasoning: '调用前',
            toolCalls: [
                { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
                { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
            ],
            at: 10,
        });
        groups.register(mapping);
        assert.equal(mapping.size, 2);
        mirrorToolResult(service, { callId: 'c1', toolName: 'f', text: '结果1', group: groups.get('c1'), at: 11 });
        mirrorToolResult(service, { callId: 'c2', toolName: 'g', text: '结果2', group: groups.get('c2'), at: 12 });
        const events = service.snapshot().events;
        assert.equal(events.filter(e => e.kind === 'tool_call').length, 2);
        const results = events.filter(e => e.kind === 'tool_result') as any[];
        assert.equal(results.length, 2);
        for (const result of results) {
            const expected = mapping.get(result.callId);
            assert.ok(expected);
            assert.equal(result.groupId, expected!.groupId);
            assert.equal(result.turnId, turnId);
        }
        assert.notEqual(mapping.get('c1')!.groupId, mapping.get('c2')!.groupId);
    },

    async testContextMirrorOrphanResult() {
        const service = await open('QQ:mirror-orphan');
        mirrorToolResult(service, { callId: 'x', text: '孤儿结果', group: null, at: 10 });
        const event = service.snapshot().events[0] as any;
        assert.equal(event.kind, 'tool_result');
        assert.ok(String(event.groupId).startsWith('orphan:'));
        assert.ok(service.projection().some(m => JSON.stringify(m).includes('孤儿结果')));
    },
};
