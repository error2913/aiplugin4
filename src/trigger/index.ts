// 触发域门面（L2）：对外只暴露收窄 API，消费方（pipeline/trigger_rule、cmd、tool）不直接摸内部实现。
//
// 注意：这里是**纯能力门面**，不含编排副作用（起轮/落盘/清理）；编排在 L4
// `pipeline/trigger_rule.ts`（方案 §13.1）。
export { createGateRuntime, evaluateGates } from "./eval";
export { PendingDelays } from "./pending";
export type { DelayScheduler, DelaySlot } from "./pending";
export {
    DEFAULT_ON_MODES,
    MODES,
    MODE_TOKENS,
    TRIGGER_CONFIG_KEYS,
    isModeOrderAlphabetical,
    modeByToken,
    triggerConfigName,
} from "./modes_meta";
export type { ModeMeta, ModeToken, TriggerConfigKey, TriggerConfigKeyMeta } from "./modes_meta";
export {
    GATE_META,
    RULE_LIMITS,
    isSourceGate,
    pickWakePrompt,
    ruleMatchesScope,
    ruleSkipReason,
    ruleWakePrompts,
    summarizeGates,
    validateRule,
} from "./rule";
export type { GateCategory, GateMeta, GateValidateContext } from "./rule";
export { STATE_WRITE_MIN_INTERVAL_MS, TriggerRuleStore, hashRuleId } from "./store";
export type { BadRuleEntry, RuleStateMap, RuleStoreOptions } from "./store";
export type * from "./types";
