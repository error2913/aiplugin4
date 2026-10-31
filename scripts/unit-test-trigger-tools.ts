// M4 单测：触发域链规则工具（set/list/delete）与校验错误路径。
import assert from 'node:assert/strict';

import { setHost } from '../src/core/host';
import { getTool } from '../src/tool/registry';
import { registerTriggerRuleTools } from '../src/tool/tools/core/tool_trigger_rule';
import { getRuleStore } from '../src/trigger/runtime';
import { Session } from '../src/session/session';

class MemoryStorage {
    map = new Map<string, string>();
    get(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
    set(key: string, value: string): void { this.map.set(key, value); }
}

setHost({
    storage: new MemoryStorage(),
    clock: { now: () => Date.now() },
    fetch: (() => Promise.reject(new Error('no fetch'))) as never,
    ext: {} as never,
});

registerTriggerRuleTools();

function makeSession(sid = 'QQ-Group:900'): Session {
    const session = new Session();
    session.sessionId = sid;
    session.setting.aiEnabled = true;
    return session;
}

const ctx = { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:20000' }, group: { groupId: 'QQ-Group:900' }, isPrivate: false } as unknown as seal.MsgContext;
const msg = {} as seal.Message;

export const tests = {
    async testCreateRuleTool(): Promise<void> {
        const session = makeSession('QQ-Group:901');
        const tool = getTool('set_trigger_rule');
        assert.ok(tool, '工具应已注册');
        const reply = await tool!.solve(ctx, msg, session, {
            wake_prompts: ['醒醒'],
            gates: [{ type: 'regex', pattern: '考试' }, { type: 'counter', n: 2 }],
        });
        assert.match(reply, /已创建规则 tr_/);
        const rules = getRuleStore().list().filter(rule => rule.scope.sessions?.includes('QQ-Group:901'));
        assert.equal(rules.length, 1);
        assert.equal(rules[0].gates.length, 2);
        assert.deepEqual(rules[0].wake_prompts, ['醒醒']);
    },

    async testCreateRuleValidationErrors(): Promise<void> {
        const session = makeSession('QQ-Group:902');
        const tool = getTool('set_trigger_rule')!;
        const reply = await tool.solve(ctx, msg, session, {
            wake_prompts: ['x'],
            gates: [{ type: 'counter', n: 2 }],
        });
        assert.match(reply, /规则校验失败/);
        assert.match(reply, /gates\[0\]/);
    },

    async testListAndDeleteTools(): Promise<void> {
        const session = makeSession('QQ-Group:903');
        const setTool = getTool('set_trigger_rule')!;
        const listTool = getTool('list_trigger_rules')!;
        const deleteTool = getTool('delete_trigger_rule')!;
        const created = await setTool.solve(ctx, msg, session, {
            wake_prompts: ['a', 'b'],
            gates: [{ type: 'regex', pattern: '天气' }, { type: 'prob', percent: 50 }],
        });
        const id = /(tr_[0-9a-z]+)/.exec(created)?.[1];
        assert.ok(id, `应返回规则 id：${created}`);
        const listed = await listTool.solve(ctx, msg, session, { scope: 'current' });
        assert.ok(listed.includes(id!), '列表应包含新规则');
        const deleted = await deleteTool.solve(ctx, msg, session, { ids: [id] });
        assert.match(deleted, /已删除 1 条/);
        assert.equal(getRuleStore().list().filter(rule => rule.scope.sessions?.includes('QQ-Group:903')).length, 0);
    },

    async testDeleteAllCurrentSession(): Promise<void> {
        const session = makeSession('QQ-Group:904');
        const setTool = getTool('set_trigger_rule')!;
        const deleteTool = getTool('delete_trigger_rule')!;
        for (const pattern of ['a', 'b', 'c']) {
            await setTool.solve(ctx, msg, session, { wake_prompts: ['x'], gates: [{ type: 'regex', pattern }] });
        }
        const reply = await deleteTool.solve(ctx, msg, session, { all: true });
        assert.match(reply, /已删除 3 条/);
    },
};
