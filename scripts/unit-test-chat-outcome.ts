// M2 单测：ChatOutcome 契约（gated / bucket-empty 两条不需要模型的早退路径）。
// fired/deferred 依赖 agent.run 与模型宿主，由启动回归（smoke）与后续集成测试覆盖。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { Session } from '../src/session/session';

function fakeCtx(): seal.MsgContext {
    return {
        endPoint: { userId: 'QQ:10000', platform: 'QQ' },
        player: { userId: 'QQ:20000' },
        group: { groupId: 'QQ-Group:30000' },
        isPrivate: false,
    } as unknown as seal.MsgContext;
}

function fakeMsg(): seal.Message {
    return { rawId: 123 } as unknown as seal.Message;
}

export const tests = {
    async testChatGatedWhenAiDisabled(): Promise<void> {
        const session = new Session();
        session.setting.aiEnabled = false;
        const outcome = await session.chat(fakeCtx(), fakeMsg(), '测试');
        assert.equal(outcome, 'gated');
        // 闸门不应扣减令牌
        assert.equal(session.bucket.count, 0);
    },

    async testChatBucketEmpty(): Promise<void> {
        // 独立 bundle 未经过启动装配：补最小 trigger 配置（只走 bucket 早退路径，不触模型）
        (Config as unknown as { trigger: unknown }).trigger = { BUCKET_LIMIT: 3, FILL_INTERVAL: 3600 };
        const session = new Session();
        session.setting.aiEnabled = true;
        session.bucket.count = 0;
        session.bucket.lastTime = Date.now();
        const outcome = await session.chat(fakeCtx(), fakeMsg(), '测试');
        assert.equal(outcome, 'bucket-empty');
    },
};
