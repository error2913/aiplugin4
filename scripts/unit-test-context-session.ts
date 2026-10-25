// 生产路径：SessionService 打开会话后，写入/请求/持久化均走 Context v2。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { PRIVILEGE_LEVEL_MAP } from '../src/config/static_config';
import { registerCmdCtx } from '../src/cmd/sub_cmd/ctx';
import { SubCmd } from '../src/cmd/root_cmd';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { getHost, setHost } from '../src/core/host';
import { SessionService } from '../src/session/session_service';
import { Session } from '../src/session/session';
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
        await session.context.addUserMessage({} as seal.MsgContext, '[img:img_user] 图', 'QQ:1', 'pm2');
        session.context.addAssistantMessage('生产路径收到', 'pa1');
        assert.ok(session.contextV2, 'SessionService 应初始化上下文服务');
        assert.equal(session.contextV2!.snapshot().events.length, 3);
        const imageEvent = session.contextV2!.snapshot().events[1] as any;
        assert.ok(imageEvent.parts.some((part: any) => part.type === 'image' && part.ref === 'img_user'), '用户消息中的图片应保留 AST');
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
        assert.equal(reopened.snapshot().events.length, 3, '重开数据仍在');
    },

    async testLegacyMigrationParsesContent() {
        installHost();
        const sid = 'QQ:legacy-image';
        const legacy = new Session();
        legacy.sessionId = sid;
        legacy.context.sessionId = sid;
        legacy.context.agentName = '*';
        legacy.context.messages = [{
            role: 'user',
            contentItems: [{ text: '[img:img_legacy] 看图', time: 1, userId: 'QQ:1', messageId: 'lm1' }],
        }] as any;
        SessionService.save(legacy);
        const saved = getHost().storage.get(sessionStorageKey(sid));
        assert.ok(saved.includes('lm1'), `旧消息应落盘（实际：${saved.slice(0, 200)}）`);
        const service = new SessionService();
        service.agentName = '*';
        const session = service.getSession(sid);
        assert.equal(session.context.messages.length, 1, '旧消息应能读回');
        assert.ok(session.contextV2, '旧会话应迁移到事件账本');
        const event = session.contextV2!.snapshot().events[0] as any;
        assert.equal(event.kind, 'user');
        assert.ok(event.parts.some((part: any) => part.type === 'image' && part.ref === 'img_legacy'), '迁移应保留图片 AST');
        assert.ok(event.parts.some((part: any) => part.type === 'text' && part.text.includes('看图')));
    },

    async testCtxCommandUserFacing() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:ctx-command';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;
        await session.context.addUserMessage({} as seal.MsgContext, '你好', 'QQ:1', 'cm1');
        registerCmdCtx();
        const command = SubCmd.map['ctx'];
        assert.ok(command);
        const replied: string[] = [];
        (seal as any).replyToSender = (_ctx: unknown, _msg: unknown, text: string) => { replied.push(String(text)); };
        const solve = (args: string[], kwargs: Array<{ name: string }> = []) => command.solve({
            ctx: { privilegeLevel: PRIVILEGE_LEVEL_MAP.master },
            msg: {},
            cmdArgs: { args, kwargs },
            epId: 'QQ:1',
            gid: '',
            sid,
            session,
            ret: {},
        } as any);

        await solve(['ctx']);
        assert.ok(replied[0].includes('上下文：共 1 条消息'), replied[0]);
        assert.equal(replied[0].includes('v2'), false);

        await solve(['ctx', 'help']);
        assert.ok(replied[1].includes('用法：.ai ctx'), replied[1]);
        assert.ok(replied[1].includes('archive'));
        assert.ok(replied[1].includes('budget='));
        assert.ok(replied[1].includes('name'));

        await solve(['ctx', 'archive', 'help']);
        assert.ok(replied[2].includes('立即整理'), replied[2]);

        await solve(['ctx', 'purge'], [{ name: 'yes' }]);
        assert.ok(replied[3].includes('已清除'), replied[3]);
        assert.equal(session.contextV2!.snapshot().events.length, 0, 'purge 后内存服务应重建为空');
        await session.context.addUserMessage({} as seal.MsgContext, '清除后的新消息', 'QQ:1', 'cm2');
        assert.equal(session.contextV2!.snapshot().events.length, 1);
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 1, 'purge 后新写入应持久化');
    },
};
