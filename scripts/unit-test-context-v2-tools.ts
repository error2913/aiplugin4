// Context v2 工具契约测试：read_raw/grep_raw/context_edit_* 通过 v2 服务读写。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import Agent from '../src/agent/agent';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import { SessionService } from '../src/session/session_service';
import { registerContextEditTools } from '../src/tool/tools/context/tool_context';
import { registerRawTools } from '../src/tool/tools/raw/tool_raw';
import { toolMap } from '../src/tool/tool';

Config.registerConfig();

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

async function makeSession(sid: string) {
    const service = new SessionService();
    service.agentName = '*';
    Agent.get = (() => ({ sessionService: service })) as any;
    const session = service.getSession(sid);
    session.sessionType = 'user';
    (session.context as any).isColdSession = () => false;
    await session.context.addUserMessage({} as seal.MsgContext, 'hello needle', 'QQ:1', 'm1');
    session.context.addAssistantMessage('reply here', 'a1');
    assert.ok(session.contextV2);
    return session;
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextV2ReadRawTool() {
        installHost();
        registerRawTools();
        registerContextEditTools();
        const session = await makeSession('QQ:toolsv2-read');
        const read = await toolMap['read_raw'].solve(null as any, null as any, session, { id: 'e:1', kind: 'user' });
        assert.ok(read.includes('hello needle'));
        assert.ok(read.includes('e:1'));
    },

    async testContextV2GrepRawTool() {
        installHost();
        registerRawTools();
        const session = await makeSession('QQ:toolsv2-grep');
        const text = await toolMap['grep_raw'].solve(null as any, null as any, session, { pattern: 'needle' });
        assert.ok(text.includes('命中 1 条'));
        assert.ok(text.includes('e:1'));
    },

    async testContextV2EditTools() {
        installHost();
        registerContextEditTools();
        registerRawTools();
        assert.ok(toolMap['context_edit_list'], 'context_edit_list 应已注册');
        assert.ok(toolMap['context_edit_replace'], 'context_edit_replace 应已注册');
        const session = await makeSession('QQ:toolsv2-edit');
        const listed = await toolMap['context_edit_list'].solve(null as any, null as any, session, { keyword: 'needle' });
        assert.ok(listed.includes('[seq=1]'));

        const replaced = await toolMap['context_edit_replace'].solve(null as any, null as any, session, {
            scope: 'idx:1',
            search: 'needle',
            replacement: 'edited',
        });
        assert.ok(replaced.includes('改动事件 1'), replaced);
        const raw = await toolMap['read_raw'].solve(null as any, null as any, session, { id: 'e:1' });
        assert.ok(raw.includes('edited'));
        assert.equal(raw.includes('needle'), false);
        await session.contextV2!.flush();
        assert.equal(session.contextV2!.snapshot().records.filter(r => r.kind === 'edit').length, 1);
    },
};
