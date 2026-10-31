// 规则库与进度分片（L2 纯能力，唯一持久化实现）：只读写 host.storage，不产生业务副作用。
//
// 存储设计（方案 §4.5）：
// - `aitrig:rules`：`{version:1, rules:[...]}` 单键；加载时逐条校验，坏条目隔离到 `aitrig:rules:bad`，
//   避免一条坏规则拖垮整个规则库；
// - `aitrig:rules:bak`：覆盖写前单键备份（SealDice storage 无删除/遍历，按时间戳命名会永久膨胀）；
// - `aitrig:state:<hash>`：按规则的触发/计数进度分片，只在 `fired` 变化时写，且默认 ≥60s 节流；
//   删规则时删分片，加载时按现存规则与会话 prune。
import { getHost } from "../core/host";
import Logger from "../logger";

import { validateRule } from "./rule";
import type { RuleScope, RuleStateShard, TriggerRule } from "./types";

const KEY_RULES = 'aitrig:rules';
const KEY_BAD = 'aitrig:rules:bad';
const KEY_BAK = 'aitrig:rules:bak';
const KEY_STATE_PREFIX = 'aitrig:state:';
/** state 写入最小间隔（默认 60s，方案 §4.5） */
export const STATE_WRITE_MIN_INTERVAL_MS = 60_000;

export interface BadRuleEntry {
    raw: string;
    errors: string[];
    at: number;
}

export interface RuleStoreOptions {
    /** 已知事件名（透传给 validateRule；不传则不做事件名白名单校验） */
    knownEvents?: readonly string[];
    /** 当前时间（毫秒，注入便于单测） */
    now?: () => number;
}

/** 一条规则的进度分片集合：sessionId → shard */
export type RuleStateMap = Record<string, RuleStateShard>;

/** 稳定短哈希（djb2 → base36），用于 state 键，避免 id 中的特殊字符 */
export function hashRuleId(ruleId: string): string {
    let hash = 5381;
    for (let i = 0; i < ruleId.length; i++) hash = ((hash << 5) + hash + ruleId.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}

function safeParse<T>(text: string | null): T | null {
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

export class TriggerRuleStore {
    private rules: TriggerRule[] = [];
    private bad: BadRuleEntry[] = [];
    /** 校验失败条目的原始 JSON（保留后随 saveAll 原样写回，避免"任何一次写入把坏规则永久删掉"） */
    private badRaw: unknown[] = [];
    private loaded = false;
    private lastStateWriteAt = new Map<string, number>();
    private readonly now: () => number;
    private readonly knownEvents?: readonly string[];

    constructor(options: RuleStoreOptions = {}) {
        this.now = options.now || (() => Date.now());
        this.knownEvents = options.knownEvents;
    }

    /** 加载规则库（幂等；坏条目写入 bad 列表，不抛） */
    load(): TriggerRule[] {
        if (this.loaded) return this.rules;
        this.loaded = true;
        this.rules = [];
        this.bad = [];
        this.badRaw = [];
        let parsed = safeParse<{ version?: number; rules?: unknown[] }>(getHost().storage.get(KEY_RULES));
        // 主键整体解析失败（宿主半写/手改）时回读覆盖写前的备份，避免"一次损坏 = 全量规则丢失"
        if (!parsed) {
            const backup = safeParse<{ version?: number; rules?: unknown[] }>(getHost().storage.get(KEY_BAK));
            if (backup && Array.isArray(backup.rules)) {
                parsed = backup;
                Logger.warning("规则库主键解析失败，已回退到 aitrig:rules:bak 备份");
            }
        }
        const rawList = parsed && Array.isArray(parsed.rules) ? parsed.rules : [];
        for (const raw of rawList) {
            const result = validateRule(raw, { scope: this.scopeOf(raw), knownEvents: this.knownEvents, now: this.now() });
            if ('rule' in result) this.rules.push(result.rule);
            else {
                this.bad.push({ raw: JSON.stringify(raw), errors: result.errors, at: this.now() });
                this.badRaw.push(raw);
            }
        }
        if (this.bad.length > 0) {
            try {
                getHost().storage.set(KEY_BAD, JSON.stringify(this.bad));
            } catch {
                // 坏条目落盘失败不影响主流程
            }
        }
        return this.rules;
    }

    /** 已加载的规则（只读快照） */
    list(): TriggerRule[] {
        if (!this.loaded) this.load();
        return [...this.rules];
    }

    getBad(): BadRuleEntry[] {
        if (!this.loaded) this.load();
        return [...this.bad];
    }

    getById(id: string): TriggerRule | undefined {
        return this.list().find(rule => rule.id === id);
    }

    /** 覆盖写前备份（单键，只保留最近 1 份） */
    private backup(): void {
        try {
            const current = getHost().storage.get(KEY_RULES);
            if (current) getHost().storage.set(KEY_BAK, current);
        } catch {
            // 备份失败不阻断写入
        }
    }

    /** 整库保存（拍平写入；调用方已保证 rules 合法） */
    saveAll(rules: TriggerRule[]): void {
        this.rules = [...rules];
        this.loaded = true;
        this.backup();
        // 坏条目原样回写：它们被排除在 this.rules 之外，但不能在下一次正常写入时静默消失
        getHost().storage.set(KEY_RULES, JSON.stringify({ version: 1, rules: [...this.rules, ...this.badRaw] }));
    }

    /** 新增或替换（按 id）；不做上限校验（由编排层做） */
    upsert(rule: TriggerRule): void {
        const current = this.list();
        const index = current.findIndex(item => item.id === rule.id);
        if (index >= 0) current[index] = rule;
        else current.push(rule);
        this.saveAll(current);
    }

    remove(id: string): boolean {
        const current = this.list();
        const next = current.filter(rule => rule.id !== id);
        if (next.length === current.length) return false;
        this.saveAll(next);
        this.removeState(id);
        return true;
    }

    /** 统计当前规则数（会话级/全局） */
    count(scopeFilter: 'global' | 'session'): number {
        return this.list().filter(rule => scopeFilter === 'global' ? !(rule.scope.sessions && rule.scope.sessions.length > 0) : !!rule.scope.sessions?.length).length;
    }

    // ---------- state 分片 ----------

    private stateKey(ruleId: string): string {
        return `${KEY_STATE_PREFIX}${hashRuleId(ruleId)}`;
    }

    readState(ruleId: string): RuleStateMap {
        return safeParse<RuleStateMap>(getHost().storage.get(this.stateKey(ruleId))) || {};
    }

    /**
     * 写进度分片（默认 ≥60s 节流；force=true 跳过节流，用于删除前/关闸前落盘）。
     * 只在 fired/计数确有变化时才调用（调用方保证），本方法只做节流与序列化。
     */
    writeState(ruleId: string, state: RuleStateMap, force = false): boolean {
        const now = this.now();
        const last = this.lastStateWriteAt.get(ruleId) || 0;
        if (!force && now - last < STATE_WRITE_MIN_INTERVAL_MS) return false;
        this.lastStateWriteAt.set(ruleId, now);
        getHost().storage.set(this.stateKey(ruleId), JSON.stringify(state));
        return true;
    }

    removeState(ruleId: string): void {
        this.lastStateWriteAt.delete(ruleId);
        // SealDice storage 没有删除 API：写空对象表示无进度（读取侧把空对象视为无状态）
        getHost().storage.set(this.stateKey(ruleId), '{}');
    }

    /** 清理孤儿分片：只对调用方给出的"现存规则 id"做无操作（无法遍历 storage，故由调用方按规则逐个 prune） */
    pruneState(ruleId: string, aliveSessions: ReadonlySet<string>): boolean {
        const state = this.readState(ruleId);
        const next: RuleStateMap = {};
        let changed = false;
        for (const [sid, shard] of Object.entries(state)) {
            if (!aliveSessions.has(sid)) {
                changed = true;
                continue;
            }
            next[sid] = shard;
        }
        if (!changed) return false;
        this.writeState(ruleId, next, true);
        return true;
    }

    /** 读取单会话进度 */
    readSessionState(ruleId: string, sessionId: string): RuleStateShard | undefined {
        return this.readState(ruleId)[sessionId];
    }

    /** 清空规则库与坏条目（仅供测试/重置） */
    resetForTest(): void {
        this.rules = [];
        this.bad = [];
        this.badRaw = [];
        this.loaded = false;
        this.lastStateWriteAt.clear();
    }

    /** 从原始规则里尽力读取 scope（校验失败时仍用于报错上下文） */
    private scopeOf(raw: unknown): RuleScope {
        const scope = (raw as { scope?: unknown })?.scope;
        return scope && typeof scope === 'object' && !Array.isArray(scope) ? scope as RuleScope : {};
    }
}
