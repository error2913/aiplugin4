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

    async testContextTooLongTightensBudget() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:context-too-long';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;
        for (let i = 0; i < 5; i++) {
            await session.context.addUserMessage({} as seal.MsgContext, `${i} `.repeat(500), 'QQ:1', `ct${i}`);
        }
        const system = { role: 'system', contentItems: [{ text: 'system prompt' }] } as any;
        const before = JSON.stringify(await handleMessages({} as seal.MsgContext, session, false, undefined, system));
        await session.context.archiveByTokenIfNeeded(200);
        assert.equal(session.context.v2BudgetCapValue, 200, '超长错误应设置临时预算上限');
        const after = JSON.stringify(await handleMessages({} as seal.MsgContext, session, false, undefined, system));
        assert.ok(after.length < before.length, `收紧预算后请求应缩短（${before.length} → ${after.length}）`);
        session.context.setV2BudgetCap(null);
        assert.equal(session.context.v2BudgetCapValue, null);
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
        assert.ok(replied[2].includes('手动归档'), replied[2]);

        // purge = 新 context epoch：内存服务重建、新写入可持久化
        await solve(['ctx', 'purge'], [{ name: 'yes' }]);
        assert.ok(replied[3].includes('已清除'), replied[3]);
        assert.equal(session.contextV2!.snapshot().events.length, 0, 'purge 后内存服务应重建为空');
        assert.equal(session.contextV2!.snapshot().events.length, 0, 'purge 后内存服务应重建为空');
        await session.context.addUserMessage({} as seal.MsgContext, '清除后的新消息', 'QQ:1', 'cm2');
        assert.equal(session.contextV2!.snapshot().events.length, 1);
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 1, 'purge 后新写入应持久化');
    },

    /**
     * 存储层大工具结果处理：
     * - 40KB 单事件不截断、可落盘（单事件页上限 256KB；多事件页 32KB 不再误伤）；
     * - >256KB 单事件在写账本前截断 text parts 并加标记，保证 flush 不永久卡死；
     * - 落盘后重开可读回（截断版）。
     */
    async testToolResultStorageLimit() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:tool-result-storage';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;

        // 1) 40KB 单事件：不截断，flush 成功（旧实现会因 >32KB 单事件页被 buildEventPage 拒绝而永久卡住）
        const text40k = '中'.repeat(40 * 1024);
        await session.context.addToolCallbackMessage(text40k, 'call_40k', 'call_ob11_api');
        const event40k = session.contextV2!.snapshot().events[0] as any;
        const stored40k = event40k.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
        assert.equal(stored40k.length, text40k.length, '40KB 单事件不应被存储层截断');
        assert.equal(stored40k.includes('[tool-result-truncated-for-storage:'), false, '不应出现截断标记');
        assert.equal((await session.contextV2!.flush()).ok, true, '40KB 单事件应可落盘');
        const reopened40k = await ContextService.open(sid);
        assert.equal(reopened40k.snapshot().events.length, 1, '40KB 单事件落盘后应可读回');
        assert.equal(
            (reopened40k.snapshot().events[0] as any).parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('').length,
            text40k.length,
            '读回原文完整',
        );

        // 2) 300KB 单事件：写账本前截断并加标记，flush 成功
        const huge = '长'.repeat(300 * 1024);
        await session.context.addToolCallbackMessage(huge, 'call_huge', 'call_ob11_api');
        const hugeEvent = session.contextV2!.snapshot().events.find((event: any) => event.kind === 'tool_result' && event.callId === 'call_huge') as any;
        assert.ok(hugeEvent, '超大工具结果应入账本');
        const storedHuge = hugeEvent.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
        assert.ok(storedHuge.length < huge.length, `超单事件页上限应截断（保留 ${storedHuge.length}/${huge.length}）`);
        assert.ok(storedHuge.includes('[tool-result-truncated-for-storage:'), '截断需带存储层标记');
        assert.equal((await session.contextV2!.flush()).ok, true, '截断后单事件页应可落盘');
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 2, '两个工具结果都应在账本里');
        const reloadedHuge = reopened.snapshot().events.find((event: any) => event.kind === 'tool_result' && event.callId === 'call_huge') as any;
        assert.ok(reloadedHuge, '重开后可读回截断版超大结果');
        assert.ok(
            reloadedHuge.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('').includes('[tool-result-truncated-for-storage:'),
            '重开后保留截断标记',
        );
    },
};

