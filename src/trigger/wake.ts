// 起轮唯一入口（L2）：把"该说话了"落成一次 session.chat，统一引用回填/提示写入/结果翻译。
//
// 为什么放 L2 而不是 L4：调度层 `timer.ts`（L2）的 activeTime 分支也要走同一入口；
// 若入口在 L4，timer 反向依赖 L4 会触发 deps ratchet。这里只依赖 L0/L2 工具与
// type-only 的 Session（运行时由调用方传入实例，不做任何 Session 值导入）。
//
// 方案 §5.7：
// - 入口已负责入库；本函数只写触发提示，不重复入库；
// - 起轮前回填 lastMsgRef（A12），保证定时/自主/事件触发的回复也能带 [CQ:reply]；
// - 返回 ChatOutcome（fired/deferred/bucket-empty/gated/quota），调用方只在 fired 时提交 delta/计数；
// - 忙判由消息入口在调 wake 之前完成（方案 A2），本函数不 defer。
import { QuotaManager } from "../quota/manager";
import type { ChatOutcome } from "../session/session";
import { SYSTEM_NAME, wakeMarker } from "../utils/protocol";
import { applyLastMessageRef } from "../utils/seal";


export type WakeKind = 'rule' | 'mode' | 'v1' | 'decision' | 'probe';

export interface WakePayload {
    kind: WakeKind;
    /** 已渲染好的唤醒提示（规则/模式/v1；空=不写系统提示，仅起轮） */
    wakeText?: string;
    /** 缺省 SYSTEM_NAME.triggerRule */
    systemName?: string;
    /** 结构化来源标记（写进 system 消息的 raw） */
    raw?: Record<string, unknown>;
    /** 起轮原因（日志与 WAIT 冷却文案） */
    reason?: string;
    /** 无 wakeText 时写 `[wake]` marker 的 cause（at/regex/active-hours/judge/external/…） */
    cause?: string;
}

/** wake 只需要 Session 的这几个能力（避免 L2 → L3 的值依赖） */
export interface WakeSessionLike {
    /** 绝对触发闸（aiEnabled）；缺失时按"未闸"处理（测试/裁剪桩） */
    setting?: { enabled(): boolean };
    /** 令牌可用性预判（只回补不扣减）；缺失时不预判（交给 chat） */
    hasBucketToken?(): boolean;
    /** 会话 id（配额归属；缺失时跳过配额预判） */
    sessionId?: string;
    /** 配额身份（优先；缺失时退化为 `{sessionId}`，因为合成轮次无触发者） */
    quotaIdentity?(): { sessionId?: string; userId?: string };
    /** 最近一条已入库事件的时间（秒）；0=空会话。供 `[wake]` 的 `[gap]` 用 */
    lastMessageAt?(): number;
    context: { addSystemUserMessage(text: string, systemName?: string, extra?: unknown): Promise<void> | void };
    save(force?: boolean): void;
    chat(ctx: seal.MsgContext, msg: seal.Message, reason?: string, toolChoice?: string, options?: { skipBucket?: boolean; bypassGate?: boolean }): Promise<ChatOutcome>;
}

/** `[gap]` 阈值：距最近一条消息 ≥1h 才写相对间隔（更短时省略，减少噪声） */
const WAKE_GAP_THRESHOLD_SEC = 3600;

/**
 * 写 `[wake]` marker：marker 是普通 SystemEvent，`[time]` 由 renderSystemEvent 渲染为写入时刻；
 * 距最近一条消息 ≥1h 时附带 `[gap] 3h12m` 相对量（不写绝对时间）。
 * 裁剪桩/测试会话可能没有 context.addSystemUserMessage ⇒ 直接跳过；写失败不阻塞起轮（marker 只是辅助信息）。
 */
export async function writeWakeMarker(session: WakeSessionLike, cause: string): Promise<void> {
    const context = session && session.context;
    if (!context || typeof context.addSystemUserMessage !== 'function') return;
    const lastAt = typeof session.lastMessageAt === 'function' ? session.lastMessageAt() : 0;
    const now = Math.floor(Date.now() / 1000);
    const gap = lastAt > 0 ? now - lastAt : 0;
    try {
        await context.addSystemUserMessage(
            wakeMarker(cause, gap >= WAKE_GAP_THRESHOLD_SEC ? gap : 0),
            SYSTEM_NAME.wake,
        );
    } catch {
        // marker 写库失败不影响起轮（下一轮如需时间，模型可调 get_time）
    }
}

/**
 * 统一写提示 + 起轮。
 * @returns session.chat 的 ChatOutcome（不含 deferred：忙判由调用方前置）
 */
export async function wakeSession(session: WakeSessionLike, ctx: seal.MsgContext, msg: seal.Message, payload: WakePayload): Promise<ChatOutcome> {
    // A12：合成 msg 无 rawId 时回填（幂等：已有 rawId 不覆盖）
    applyLastMessageRef(session as never, ctx, msg);
    // 方案 C6：先判闸/判桶再写提示——未真正起轮（gated/bucket-empty）时不留无法兑现的 system 提示，
    // 否则 .ai off / 全局待机 / 桶空期间规则/模式 timer 会持续往上下文灌"请说话"。
    if (session.setting && typeof session.setting.enabled === 'function' && !session.setting.enabled()) {
        return 'gated';
    }
    if (session.hasBucketToken && !session.hasBucketToken()) {
        return 'bucket-empty';
    }
    // 用量限制：未真正起轮时不写提示（否则限流期间规则/模式 timer 会持续灌"请说话"）
    const sid = session.sessionId || '';
    const identity = typeof session.quotaIdentity === 'function'
        ? session.quotaIdentity()
        : { sessionId: sid, userId: '' };
    if (identity.sessionId || sid) {
        const denial = QuotaManager.checkChat({ sessionId: identity.sessionId || sid, userId: identity.userId || '' });
        if (denial) {
            if (QuotaManager.notifyOnce(identity.sessionId || sid, denial)) {
                seal.replyToSender(ctx, msg, QuotaManager.formatDenialText(denial));
            }
            return 'quota';
        }
    }
    const text = payload.wakeText && payload.wakeText.trim() ? payload.wakeText : '';
    const systemName = payload.systemName || SYSTEM_NAME.triggerRule;
    if (text) {
        await session.context.addSystemUserMessage(text, systemName, {
            raw: { kind: 'trigger-rule', source: payload.kind, ...(payload.raw || {}) },
        });
        // 提示已入库，先落盘再起轮（避免起轮失败/重载时提示丢失）
        session.save(true);
    } else {
        // 无 wakeText 的入口没有承载"现在"的事件（历史 [time] 已隐藏）⇒ 补 `[wake]` marker
        await writeWakeMarker(session, payload.cause || payload.kind);
        session.save(true);
    }
    return session.chat(ctx, msg, payload.reason || defaultReason(payload.kind), undefined, {});
}

function defaultReason(kind: WakeKind): string {
    switch (kind) {
        case 'rule': return '触发规则';
        case 'mode': return '单触发';
        case 'v1': return '事件触发';
        case 'decision': return '评分触发';
        case 'probe': return '静默探针';
        default: return '触发';
    }
}

/** 起轮结果是否应提交规则增量/计数（只有真正起轮才记账） */
export function shouldCommit(outcome: ChatOutcome): boolean {
    return outcome === 'fired';
}
