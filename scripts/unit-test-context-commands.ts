// `.ai ctx` 命令逻辑单测：解析/状态/遗忘/清除确认/归档/修复/未接线提示。
import assert from 'node:assert/strict';

import { formatCtxStatus, parseCtxCommand, runCtxCommand } from '../src/context/commands';
import { eventPageKey } from '../src/context/keys';
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

let storage = new FakeStorage();

function installHost(): void {
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

async function seed(sid: string): Promise<ContextService> {
    storage = new FakeStorage();
    installHost();
    const service = await ContextService.open(sid);
    service.appendUser('QQ:1', 'm1', [{ type: 'text', text: '一' }]);
    service.appendAssistant('a1', [{ type: 'text', text: '二' }]);
    assert.equal((await service.flush()).ok, true);
    return service;
}

export const tests: Record<string, () => void | Promise<void>> = {
    testContextCommandsParse() {
        assert.equal(parseCtxCommand([]).action, 'status');
        assert.equal(parseCtxCommand(['archive']).action, 'archive');
        assert.equal(parseCtxCommand(['hide']).target, 'all');
        assert.equal(parseCtxCommand(['hide', 'user']).target, 'user');
        assert.equal(parseCtxCommand(['hide', 'bad']).error !== undefined, true);
        assert.equal(parseCtxCommand(['purge']).confirmed, false);
        assert.equal(parseCtxCommand(['purge', '--yes']).confirmed, true);
        assert.deepEqual(parseCtxCommand(['set', 'budget=1000', 'retain=40']), { action: 'set', budget: 1000, retain: 40 });
        assert.equal(parseCtxCommand(['nope']).action, 'help');
        assert.equal(parseCtxCommand(['archive', 'help']).helpTopic, 'archive');
        assert.equal(parseCtxCommand(['help', 'purge']).helpTopic, 'purge');
    },

    async testContextCommandsStatus() {
        const sid = 'QQ:cmd-status';
        const service = await seed(sid);
        const result = await runCtxCommand({ sessionId: sid, service, args: [] });
        assert.ok(result.text.includes('上下文：共 2 条消息'));
        assert.ok(result.text.includes('更早内容'));
        const formatted = formatCtxStatus({ sessionId: sid, service, args: [] });
        assert.ok(formatted.includes('上下文：'));
        assert.equal(formatted.includes('v2'), false, '用户可见文本不暴露实现版本');
    },

    async testContextCommandsHideAndPurge() {
        const sid = 'QQ:cmd-hide';
        const service = await seed(sid);
        const hidden = await runCtxCommand({ sessionId: sid, service, args: ['hide', 'all'] });
        assert.equal(hidden.changed, true);
        assert.ok(hidden.text.includes('已隐藏'));
        assert.equal(service.projection().length, 0);
        await service.flush();
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.projection().length, 0);

        const confirm = await runCtxCommand({ sessionId: sid, service: reopened, args: ['purge'] });
        assert.equal(confirm.needsConfirm, true);
        assert.ok(confirm.text.includes('--yes'));

        const purged = await runCtxCommand({ sessionId: sid, service: reopened, args: ['purge', '--yes'] });
        assert.equal(purged.changed, true);
        assert.ok(purged.text.includes('已清除'));
        assert.equal(storage.map.get(eventPageKey(sid, 1)), '');
    },

    async testContextCommandsArchiveAndRepair() {
        const sid = 'QQ:cmd-archive';
        const service = await seed(sid);
        const noRuntime = await runCtxCommand({ sessionId: sid, service, args: ['archive'] });
        assert.ok(noRuntime.text.includes('暂时无法整理'));

        const runtime = {
            archiveNow: async () => ({ ran: true, advanced: true, through: 2 }),
            getLastResult: () => null,
        } as any;
        const archived = await runCtxCommand({ sessionId: sid, service, args: ['archive'], runtime });
        assert.equal(archived.changed, true);
        assert.ok(archived.text.includes('已整理更早内容'));

        const repaired = await runCtxCommand({ sessionId: sid, service, args: ['repair'] });
        assert.ok(repaired.text.includes('上下文索引'));
        const missing = await runCtxCommand({ sessionId: 'QQ:no-head', service, args: ['repair'] });
        assert.ok(missing.text.includes('不存在'));
    },

    async testContextCommandsSetAndName() {
        const sid = 'QQ:cmd-set';
        const service = await seed(sid);
        const overrides: Record<string, unknown> = {};
        const fakeSession = {
            setting: { overrides },
            save: () => undefined,
            context: {
                autoNameMod: 0,
                userInfoList: [{ id: 'QQ:1', name: '甲' }],
                setName: async () => undefined,
            },
        } as any;
        const set = await runCtxCommand({ sessionId: sid, service, session: fakeSession, args: ['set', 'budget=100'] });
        assert.ok(set.text.includes('已更新'));
        assert.equal(overrides.ctxBudgetTokens, 100);
        const name = await runCtxCommand({ sessionId: sid, service, session: fakeSession, args: ['name', 'status'] });
        assert.ok(name.text.includes('上下文名字'));
        assert.equal(name.text.includes('v2'), false);
        const help = await runCtxCommand({ sessionId: sid, service, args: ['unknown'] });
        assert.ok(help.text.includes('用法'));
    },
};
