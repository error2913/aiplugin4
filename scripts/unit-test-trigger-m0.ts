// M0 回归单测：#151 P0 —— 原生 poke eventType 修正 + A12「引用回填」。
// - poke：pipeline.ts 原生路径应产出 eventType='poke'（白名单口径），不能再是 'notify.poke'
// - A12：Session.lastMsgRef 按端点记录真实用户消息原始 rawId；合成 msg 起轮前回填
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Session } from '../src/session/session';
import { applyLastMessageRef } from '../src/utils/seal';

interface FakeCtx {
    endPoint: { userId: string };
    player: { userId: string };
    isPrivate: boolean;
}

function fakeCtx(epId: string, sender: string): FakeCtx {
    return { endPoint: { userId: epId }, player: { userId: sender }, isPrivate: false };
}

function fakeMsg(rawId: number): seal.Message {
    return { rawId } as unknown as seal.Message;
}

export const tests = {
    /** 原生 poke 事件视图的 eventType 必须与事件白名单一致（'poke'） */
    testPokeEventTypeFixed(): void {
        // 测试进程 cwd = 仓库根（npm run test:unit）
        const file = path.join(process.cwd(), 'src', 'pipeline.ts');
        const source = fs.readFileSync(file, 'utf8');
        assert.ok(!/eventType:\s*'notify\.poke'/.test(source), 'pipeline 原生 poke 不应再产出 notify.poke');
        assert.ok(/eventType:\s*'poke'/.test(source), 'pipeline 原生 poke 应产出 poke');
    },

    /** 按端点分别记录，互不覆盖 */
    testNoteInboundRefPerEndpoint(): void {
        const session = new Session();
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, fakeMsg(123));
        session.noteInboundRef(fakeCtx('QQ:bot2', 'QQ:user') as seal.MsgContext, fakeMsg(456));
        assert.equal(session.lastMsgRef['QQ:bot1'], 123);
        assert.equal(session.lastMsgRef['QQ:bot2'], 456);
    },

    /** rawId=0、bot 自身、updateRef=false（命令/补收）都不更新 */
    testNoteInboundRefIgnoresInvalid(): void {
        const session = new Session();
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, fakeMsg(0));
        assert.deepEqual(session.lastMsgRef, {});
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:bot1') as seal.MsgContext, fakeMsg(9));
        assert.deepEqual(session.lastMsgRef, {});
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, fakeMsg(7), false);
        assert.deepEqual(session.lastMsgRef, {});
    },

    /** 上限 8：超限淘汰最早写入的端点 */
    testNoteInboundRefCapsEight(): void {
        const session = new Session();
        for (let i = 1; i <= 10; i++) {
            session.noteInboundRef(fakeCtx(`QQ:bot${i}`, 'QQ:user') as seal.MsgContext, fakeMsg(i));
        }
        const keys = Object.keys(session.lastMsgRef);
        assert.equal(keys.length, 8);
        assert.equal(session.lastMsgRef['QQ:bot1'], undefined);
        assert.equal(session.lastMsgRef['QQ:bot10'], 10);
    },

    /** 合成 msg（无 rawId）用同端点最近真实用户消息回填 */
    testApplyLastMessageRefFills(): void {
        const session = new Session();
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, fakeMsg(321));
        const msg = fakeMsg(0);
        applyLastMessageRef(session, fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, msg);
        assert.equal(msg.rawId, 321);
    },

    /** 已有 rawId 的路径（poke/消息入口）不被覆盖 */
    testApplyLastMessageRefKeepsExisting(): void {
        const session = new Session();
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, fakeMsg(321));
        const msg = fakeMsg(999);
        applyLastMessageRef(session, fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, msg);
        assert.equal(msg.rawId, 999);
    },

    /** 端点不匹配时不回填（防止同端点多会话串引） */
    testApplyLastMessageRefOtherEndpoint(): void {
        const session = new Session();
        session.noteInboundRef(fakeCtx('QQ:bot1', 'QQ:user') as seal.MsgContext, fakeMsg(321));
        const msg = fakeMsg(0);
        applyLastMessageRef(session, fakeCtx('QQ:bot2', 'QQ:user') as seal.MsgContext, msg);
        assert.ok(!msg.rawId);
    },
};
