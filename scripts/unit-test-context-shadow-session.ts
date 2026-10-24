// 阴影集成：真实旧 Context 写入 + 镜像到 v2，再与 v2 projection 逐行比对。
import assert from 'node:assert/strict';

import Agent from '../src/agent/agent';
import Config from '../src/config/config';
import { attachV2Mirror, setV2MirrorEnabled } from '../src/context/mirror';
import { ContextService } from '../src/context/service';
import { compareShadow, formatShadowReport } from '../src/context/shadow';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import { Session } from '../src/session/session';

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

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextShadowRealSession() {
        installHost();
        const originalGet = Agent.get;
        const session = new Session();
        session.agentName = '*';
        session.sessionId = 'QQ:shadow-session';
        session.sessionType = 'user';
        session.context.agentName = '*';
        session.context.sessionId = session.sessionId;
        const fakeAgent = {
            sessionService: { getSession: () => session },
            chat: async () => ({ content: '' }),
        } as any;
        Agent.get = (() => fakeAgent) as typeof Agent.get;
        // 强制走热态路径，避免依赖 stateOf/时间
        (session.context as any).isColdSession = () => false;
        Config.registerConfig();

        const service = await ContextService.open(session.sessionId);
        attachV2Mirror(session.context, service);
        setV2MirrorEnabled(true);
        try {
            await session.context.addUserMessage({} as seal.MsgContext, '你好', 'QQ:1', 'm1');
            session.context.addAssistantMessage('收到', 'a1');
            session.context.addToolCallsMessage([
                { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ] as any);
            await session.context.addToolCallbackMessage('工具结果', 'c1', 'f');
            session.context.addSystemUserMessage('撤回', '事件', { eventType: 'group_recall', raw: { id: 1 } });

            const report = compareShadow(session.context.messages, service.projection());
            assert.equal(report.equal, true, formatShadowReport(report));
        } finally {
            setV2MirrorEnabled(false);
            attachV2Mirror(session.context, null);
            Agent.get = originalGet;
        }
    },
};
