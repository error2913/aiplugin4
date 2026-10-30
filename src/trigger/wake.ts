// 起轮唯一入口（L2）：把"该说话了"落成一次 session.chat，统一引用回填/提示写入/结果翻译。
//
// 为什么放 L2 而不是 L4：调度层 `timer.ts`（L2）的 activeTime 分支也要走同一入口；
// 若入口在 L4，timer 反向依赖 L4 会触发 deps ratchet。这里只依赖 L0/L2 工具与
// type-only 的 Session（运行时由调用方传入实例，不做任何 Session 值导入）。
//
// 方案 §5.7：
// - 入口已负责入库；本函数只写触发提示，不重复入库；
// - 起轮前回填 lastMsgRef（A12），保证定时/自主/事件触发的回复也能带 [CQ:reply]；
// - 返回 ChatOutcome（fired/deferred/bucket-empty/gated），调用方只在 fired 时提交 delta/计数；
// - 忙判由消息入口在调 wake 之前完成（方案 A2），本函数不 defer。
import type { ChatOutcome } from "../session/session";
import { SYSTEM_NAME } from "../utils/protocol";
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
}

/** wake 只需要 Session 的这三个能力（避免 L2 → L3 的值依赖） */
export interface WakeSessionLike {
    context: { addSystemUserMessage(text: string, systemName?: string, extra?: unknown): Promise<void> | void };
    save(force?: boolean): void;
    chat(ctx: seal.MsgContext, msg: seal.Message, reason?: string, toolChoice?: string, options?: { skipBucket?: boolean; bypassGate?: boolean }): Promise<ChatOutcome>;
}

/**
 * 统一写提示 + 起轮。
 * @returns session.chat 的 ChatOutcome（不含 deferred：忙判由调用方前置）
 */
export async function wakeSession(session: WakeSessionLike, ctx: seal.MsgContext, msg: seal.Message, payload: WakePayload): Promise<ChatOutcome> {
    // A12：合成 msg 无 rawId 时回填（幂等：已有 rawId 不覆盖）
    applyLastMessageRef(session as never, ctx, msg);
    const text = payload.wakeText && payload.wakeText.trim() ? payload.wakeText : '';
    const systemName = payload.systemName || SYSTEM_NAME.triggerRule;
    if (text) {
        await session.context.addSystemUserMessage(text, systemName, {
            raw: { kind: 'trigger-rule', source: payload.kind, ...(payload.raw || {}) },
        });
        // 提示已入库，先落盘再起轮（避免起轮失败/重载时提示丢失）
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
