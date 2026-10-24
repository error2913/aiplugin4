// 生产路径：SessionService 打开会话后，写入/请求/持久化均走 Context v2。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { getHost, setHost } from '../src/core/host';
import { SessionService } from '../src/session/session_service';
import { sessionStorageKey } from '../src/session/persistence';
import { handleMessages } from '../src/utils/message';

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

Config.registerConfig();

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextSessionServiceV2Path() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:session-service-v2';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;
        await session.context.addUserMessage({} as seal.MsgContext, '生产路径你好', 'QQ:1', 'pm1');
        session.context.addAssistantMessage('生产路径收到', 'pa1');
        assert.ok(session.contextV2, 'SessionService 应初始化上下文服务');
        assert.equal(session.contextV2!.snapshot().events.length, 2);
        assert.ok(session.context.messages.length > 0, '旧消费者通过投影读取');

        const system = { role: 'system', contentItems: [{ text: 'system prompt' }] } as any;
        const request = await handleMessages({} as seal.MsgContext, session, false, undefined, system);
        assert.ok(JSON.stringify(request).includes('生产路径你好'));
        assert.ok(JSON.stringify(request).includes('生产路径收到'));

        SessionService.save(session);
        const raw = getHost().storage.get(sessionStorageKey(sid));
        assert.ok(raw);
        assert.equal(raw.includes('"messages"'), false, '旧消息数组不再落盘');
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 2, '重开数据仍在');
    },
};
