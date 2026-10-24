// 阴影集成：真实旧 Context 写入 + 镜像到 v2，再与 v2 projection 逐行比对。
import assert from 'node:assert/strict';

import Agent from '../src/agent/agent';
import Config from '../src/config/config';
import { attachV2Mirror, setV2MirrorEnabled } from '../src/context/mirror';
import { ContextService } from '../src/context/service';
import { compareShadow, formatShadowReport } from '../src/context/shadow';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { getHost, setHost } from '../src/core/host';
import { Session } from '../src/session/session';
import { sessionStorageKey } from '../src/session/persistence';
import { SessionService } from '../src/session/session_service';
import { handleMessages } from '../src/utils/message';

// 本 bundle 独立注册一次配置；重复调用会因 defineProperty 不可重定义而报错
Config.registerConfig();
// 请求影子按原生工具模式对比（PE 分支的旧路径会丢弃 tool_calls，另行处理）
const TEST_CONFIG = (globalThis as any).__TEST_CONFIG__;
TEST_CONFIG.boolConfigs['切换为提示词工程'] = false;
(Config as any).cache = {};

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

async function withShadowSession(
    sid: string,
    fn: (session: Session, service: ContextService) => Promise<void>,
): Promise<void> {
    installHost();
    const originalGet = Agent.get;
    const session = new Session();
    session.agentName = '*';
    session.sessionId = sid;
    session.sessionType = 'user';
    session.context.agentName = '*';
    session.context.sessionId = sid;
    const fakeAgent = {
        sessionService: { getSession: () => session },
        chat: async () => ({ content: '' }),
    } as any;
    Agent.get = (() => fakeAgent) as typeof Agent.get;
    // 强制走热态路径，避免依赖 stateOf/时间
    (session.context as any).isColdSession = () => false;

    const service = await ContextService.open(sid);
    attachV2Mirror(session.context, service);
    setV2MirrorEnabled(true);
    try {
        await fn(session, service);
    } finally {
        setV2MirrorEnabled(false);
        attachV2Mirror(session.context, null);
        Agent.get = originalGet;
    }
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextShadowRealSession() {
        await withShadowSession('QQ:shadow-session', async (session, service) => {
            await session.context.addUserMessage({} as seal.MsgContext, '你好', 'QQ:1', 'm1');
            session.context.addAssistantMessage('收到', 'a1');
            session.context.addToolCallsMessage([
                { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ] as any);
            await session.context.addToolCallbackMessage('工具结果', 'c1', 'f');
            session.context.addSystemUserMessage('撤回', '事件', { eventType: 'group_recall', raw: { id: 1 } });

            const report = compareShadow(session.context.messages, service.projection());
            assert.equal(report.equal, true, formatShadowReport(report));
        });
    },

    async testContextShadowMultiTurnAndTools() {
        await withShadowSession('QQ:shadow-multi', async (session, service) => {
            // 连续 user：旧 Context 合并为一个 user 消息；v2 也合并为同一请求单元
            await session.context.addUserMessage({} as seal.MsgContext, '第一句', 'QQ:1', 'm1');
            await session.context.addUserMessage({} as seal.MsgContext, '第二句', 'QQ:2', 'm2');
            session.context.addAssistantMessage('回复一', 'a1');
            session.context.addAssistantMessage('回复二', 'a2');
            session.context.addToolCallsMessage([
                { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
                { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
            ] as any);
            await session.context.addToolCallbackMessage('结果一', 'c1', 'f');
            await session.context.addToolCallbackMessage('结果二', 'c2', 'g');
            session.context.addSystemUserMessageTracked('事件正文', '事件', { eventType: 'group_recall', raw: { id: 2 } });

            const report = compareShadow(session.context.messages, service.projection());
            assert.equal(report.equal, true, formatShadowReport(report));
        });
    },

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
        assert.ok(session.contextV2, 'SessionService 应初始化 contextV2');
        assert.equal(session.contextV2!.snapshot().events.length, 2);
        assert.ok(session.context.messages.length > 0, '旧消费者通过 projection 读取');

        const system = { role: 'system', contentItems: [{ text: 'system prompt' }] } as any;
        const request = await handleMessages({} as seal.MsgContext, session, false, undefined, system);
        assert.ok(JSON.stringify(request).includes('生产路径你好'));
        assert.ok(JSON.stringify(request).includes('生产路径收到'));

        SessionService.save(session);
        const raw = getHost().storage.get(sessionStorageKey(sid));
        assert.ok(raw);
        assert.equal(raw.includes('"messages"'), false, 'v2 启用后旧 messages 不再落盘');
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 2, '重开 v2 数据仍在');
    },
};
