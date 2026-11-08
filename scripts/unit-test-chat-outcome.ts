// M2 单测：ChatOutcome 契约（gated / bucket-empty / quota 三条不需要模型的早退路径）。
// fired/deferred 依赖 agent.run 与模型宿主，由启动回归（smoke）与后续集成测试覆盖。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { setHost } from '../src/core/host';
import { QuotaManager } from '../src/quota/manager';
import { resetStoreCacheForTest } from '../src/quota/store';
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

const WINDOW_NOW = new Date(2026, 10, 5, 10, 0, 0).getTime();

/** 注入可写内存存储 + 假时钟（配额判定要用确定的窗口键） */
function installQuotaHost(): void {
    const map = new Map<string, string>();
    setHost({
        storage: {
            get: (key: string) => (map.has(key) ? map.get(key)! : null),
            set: (key: string, value: string) => { map.set(key, value); },
        },
        clock: { now: () => WINDOW_NOW },
        fetch: (() => { throw new Error('no fetch in chat-outcome tests'); }) as never,
        ext: {} as never,
    });
    resetStoreCacheForTest();
    QuotaManager.reset();
}

/** 关闭配额（用完必须调用，避免把后续用例一起拦住） */
function disableQuota(): void {
    QuotaManager.configure(() => ({
        ENABLED: false,
        LIMIT_5H: 0,
        LIMIT_WEEK: 0,
        LIMIT_MONTH: 0,
        SESSION_PERCENT: 100,
        USER_PERCENT: 100,
        PEAK_RULE: { segments: [], warnings: [] },
        PURPOSE_PERCENT: {
            summarization: 100,
            judge: 100,
            'image-understanding': 100,
            'text-embedding': 100,
        },
        NOTIFY_ON_LIMIT: false,
    }));
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

    /** 配额拒绝：返回 'quota'，不扣桶、不迁移标签、不写提示（FR-BLK-01） */
    async testChatQuotaNoBucketDeduct(): Promise<void> {
        (Config as unknown as { trigger: unknown }).trigger = { BUCKET_LIMIT: 3, FILL_INTERVAL: 3600 };
        installQuotaHost();
        QuotaManager.configure(() => ({
            ENABLED: true,
            LIMIT_5H: 100,
            LIMIT_WEEK: 0,
            LIMIT_MONTH: 0,
            SESSION_PERCENT: 100,
            USER_PERCENT: 100,
            PEAK_RULE: { segments: [], warnings: [] },
            PURPOSE_PERCENT: {
                summarization: 100,
                judge: 100,
                'image-understanding': 100,
                'text-embedding': 100,
            },
            NOTIFY_ON_LIMIT: false,
        }));
        try {
            const sid = 'QQ-Group:quota-1';
            QuotaManager.record('chat', 100, { sessionId: sid, userId: 'QQ:20000' });
            const session = new Session();
            session.sessionId = sid;
            session.setting.aiEnabled = true;
            session.bucket.count = 3;
            session.bucket.lastTime = Date.now();
            const outcome = await session.chat(fakeCtx(), fakeMsg(), '测试');
            assert.equal(outcome, 'quota');
            assert.equal(session.bucket.count, 3, 'quota 拒绝不得扣减令牌');
            assert.equal(session.running, false, 'quota 拒绝不得起轮');
        } finally {
            disableQuota();
        }
    },

    /** 配额身份：私聊 sid==uid；群聊取触发者；子代理预置值不被 chat 覆盖 */
    async testQuotaIdentityAssignment(): Promise<void> {
        (Config as unknown as { trigger: unknown }).trigger = { BUCKET_LIMIT: 3, FILL_INTERVAL: 3600 };
        disableQuota();
        try {
            const group = new Session();
            group.sessionId = 'QQ-Group:quota-2';
            group.sessionType = 'group';
            group.setting.aiEnabled = true;
            group.bucket.count = 0;
            group.bucket.lastTime = Date.now();
            await group.chat(fakeCtx(), fakeMsg(), '测试'); // bucket-empty 早退，但身份已赋值
            assert.equal(group.quotaIdentity().sessionId, 'QQ-Group:quota-2');
            assert.equal(group.quotaIdentity().userId, 'QQ:20000', '群聊取触发者');

            const child = new Session();
            child.sessionId = 'sub:abc';
            child.sessionType = 'group';
            child.headless = true;
            child.quotaSessionId = 'QQ-Group:root';
            child.quotaUserId = 'QQ:owner';
            child.setting.aiEnabled = true;
            child.bucket.count = 0;
            child.bucket.lastTime = Date.now();
            await child.chat(fakeCtx(), fakeMsg(), '测试');
            assert.equal(child.quotaIdentity().sessionId, 'QQ-Group:root', '子代理必须归到根会话');
            assert.equal(child.quotaIdentity().userId, 'QQ:owner', '子代理发起者不被覆盖');

            // 私聊：sid == uid（同一个 QQ 号）。这样「会话档」与「个人档」是同一份账，
            // 取 min 即等于取较小的那个百分比，不会出现两档各算一次而互相抵消。
            const priv = new Session();
            priv.sessionId = 'QQ:quota-3';
            priv.sessionType = 'user';
            priv.setting.aiEnabled = true;
            priv.bucket.count = 0;
            priv.bucket.lastTime = Date.now();
            const privCtx = { ...fakeCtx(), isPrivate: true, group: null } as unknown as seal.MsgContext;
            await priv.chat(privCtx, fakeMsg(), '测试');
            assert.equal(priv.quotaIdentity().sessionId, 'QQ:quota-3');
            assert.equal(priv.quotaIdentity().userId, 'QQ:quota-3', '私聊 sid==uid');
            assert.equal(priv.quotaIdentity().sessionId, priv.quotaIdentity().userId, '私聊两档同一份账');
        } finally {
            disableQuota();
        }
    },
};
