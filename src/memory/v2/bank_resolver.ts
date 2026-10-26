// Bank 解析：Session → user/group/global 记忆银行；bankId 与 kind 必须一致。
import type { BankKind } from "./types";

export interface BankTarget {
    bankId: string;
    kind: BankKind;
    agentName?: string;
    sessionId?: string;
}

function safeId(id: string): string {
    return String(id || 'unknown').replace(/[^a-zA-Z0-9_:\-]/g, '_');
}

export function resolveBankId(sessionId: string, kind: BankKind = 'user', agentName = '*'): BankTarget {
    const prefix = kind === 'user' ? 'user' : kind === 'group' ? 'group' : 'global';
    const id = safeId(sessionId);
    return {
        bankId: `${prefix}_${id}`,
        kind,
        agentName,
        sessionId: kind === 'global' ? undefined : sessionId,
    };
}

export function resolveGlobalBank(agentName = '*'): BankTarget {
    const name = !agentName || agentName === '*' ? 'main' : safeId(agentName);
    return { bankId: `global_${name}`, kind: 'global', agentName: name === 'main' ? '*' : agentName };
}

export function bankKindOfBankId(bankId: string): BankKind {
    const sep = bankId.indexOf('_');
    const prefix = sep >= 0 ? bankId.slice(0, sep) : bankId;
    if (prefix === 'user' || prefix === 'group' || prefix === 'global') return prefix;
    return 'global';
}
