// 记忆工具共享：bank 解析 + `[mem:id]` 引用归一。
// 供 memory_* 工具与 resolve_context_ref 共用，避免两套 scope/target 口径。
import { PRIVILEGE_LEVEL_MAP } from "../../../config/static_config";
import { MemoryService } from "../../../memory/service";
import { normalizeMemoryRef } from "../../../memory/v2/ref";
import type { Session } from "../../../session/session";

export function currentBank(session: Session): { bankId: string; kind: 'user' | 'group' } {
    const kind = session.sessionType === 'group' ? 'group' : 'user';
    return { bankId: MemoryService.bankIdForSessionId(session.sessionId, session.agentName), kind };
}

export function resolveBank(
    session: Session,
    scope?: string,
    targetId?: string,
): { ok: true; bankId: string; kind: 'user' | 'group' | 'global' } | { ok: false; error: string } {
    const kind = scope === 'group' ? 'group' : scope === 'global' ? 'global' : scope === 'user' ? 'user' : (session.sessionType === 'group' ? 'group' : 'user');
    if (kind === 'global') {
        if ((session.setting?.priv ?? 0) < PRIVILEGE_LEVEL_MAP.master) return { ok: false, error: 'global 记忆仅骰主会话可写' };
        return { ok: true, bankId: MemoryService.globalBankId(session.agentName), kind };
    }
    const current = currentBank(session);
    if (!targetId) return { ok: true, bankId: current.bankId, kind: current.kind };
    const expected = kind === 'group' ? (session.sessionType === 'group' ? session.sessionId : '') : (session.sessionType === 'user' ? session.sessionId : '');
    if (targetId !== expected && (session.setting?.priv ?? 0) < PRIVILEGE_LEVEL_MAP.master) {
        return { ok: false, error: `目标 ${targetId} 不是当前会话；跨目标仅骰主可用` };
    }
    return { ok: true, bankId: MemoryService.bankIdForSessionId(targetId, session.agentName), kind };
}

/** 工具参数里的 id 允许直接粘贴 `[mem:id]` / `mem:id` */
export function memoryIdArg(raw: unknown): string {
    return normalizeMemoryRef(raw);
}

/** 当前会话可见的记忆 bank 候选（按注入顺序）：当前 → 全局 → 最近发言者个人 bank */
export function candidateMemoryBanks(session: Session): Array<{ bankId: string; kind: 'user' | 'group' | 'global' }> {
    const out: Array<{ bankId: string; kind: 'user' | 'group' | 'global' }> = [];
    const seen = new Set<string>();
    const push = (bankId: string, kind: 'user' | 'group' | 'global') => {
        if (!bankId || seen.has(bankId)) return;
        seen.add(bankId);
        out.push({ bankId, kind });
    };

    const current = currentBank(session);
    push(current.bankId, current.kind);
    push(MemoryService.globalBankId(session.agentName), 'global');

    // 群聊注入的个人 bank 来自最近发言者；按事件从新到旧收集 uid（最多 3 个，与注入侧一致）
    const events = session.contextV2?.snapshot().events ?? [];
    const userIds: string[] = [];
    for (let i = events.length - 1; i >= 0 && userIds.length < 3; i--) {
        const event = events[i];
        if (event.kind !== 'user') continue;
        const uid = String(event.uid || '');
        if (!uid || uid === session.sessionId || userIds.includes(uid)) continue;
        userIds.push(uid);
    }
    for (const uid of userIds) push(MemoryService.bankIdForSessionId(uid, session.agentName), 'user');
    return out;
}
