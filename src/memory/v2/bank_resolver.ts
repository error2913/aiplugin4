// Bank 解析：把 Session / Agent 映射为 Hindsight-like 的隔离记忆银行。
import type { BankKind } from "./types";

export interface BankTarget {
    bankId: string;
    kind: BankKind;
    agentName?: string;
}

function safeId(id: string): string {
    return String(id || 'unknown').replace(/[^a-zA-Z0-9_:\-]/g, '_');
}

export function resolveBankId(sessionId: string, kind: BankKind = 'user', agentName = '*'): BankTarget {
    const prefix = kind === 'user' ? 'user' : kind === 'group' ? 'group' : 'global';
    return {
        bankId: `${prefix}_${safeId(sessionId)}`,
        kind,
        agentName,
    };
}

export function resolveGlobalBank(agentName = '*'): BankTarget {
    return { bankId: `global_${safeId(agentName)}`, kind: 'global', agentName };
}
