// 触发域纯类型（L1，仅类型）：只允许 type-only 引用，保证 L1 不产生运行时依赖。
//
// 消费方：trigger/rule（校验/摘要）、trigger/eval（求值）、pipeline/trigger_rule（编排，L4）。
// 规则 JSON 契约见方案 §4.1；门契约见 §4.2。

/** 门类型（8 种，固定） */
export type GateType = 'regex' | 'event' | 'active_time' | 'timer' | 'user' | 'counter' | 'prob' | 'delay';

/** 源门：必须且只能出现在 gates[0] */
export type SourceGateType = 'regex' | 'event' | 'active_time' | 'timer';
/** 过滤门：可出现任意位置（源门之后） */
export type FilterGateType = 'user' | 'counter' | 'prob';
/** 时序门：防抖，可出现任意位置（源门/过滤门之后） */
export type TimingGateType = 'delay';

export interface RegexGate {
    type: 'regex';
    /** 正则源码，≤200 字 */
    pattern: string;
    /** 支持的 flags 子集：i/m/s */
    flags?: string;
}

export interface EventGate {
    type: 'event';
    /** 单一扁平事件名（如 group_increase / poke） */
    on: string;
    /** v1 条件数组（结构与 event/trigger 的 EventTriggerCondition 一致，≤10 条） */
    match?: unknown[];
}

export interface ActiveTimeGate {
    type: 'active_time';
    /** HH:mm，必填 */
    start: string;
    /** HH:mm，必填 */
    end: string;
    /** 分段数（每段最多触发 1 次），缺省 1 */
    segs?: number;
}

/** 定时器门：参数与 set_timer / 全局默认定时器完全一致（含 prompts） */
export interface TimerGate {
    type: 'timer';
    types: 'target' | 'interval';
    years?: number;
    months?: number;
    days?: number;
    hours?: number;
    minutes: number;
    /** interval 次数；-1 无限；target 固定 1 */
    count?: number;
    /** 唤醒文本（1~10 条，fire 随机一条），必填 */
    prompts: string[];
}

export interface UserGate {
    type: 'user';
    /** 允许的 UNI-ID（含平台前缀），≤20 字符/项 */
    ids: string[];
    /** 排除的 UNI-ID */
    exclude?: string[];
}

export interface CounterGate {
    type: 'counter';
    /** 1..1000：前序门通过次数达到 n 时通过并归零 */
    n: number;
}

export interface ProbGate {
    type: 'prob';
    /** 1..100（百分比） */
    percent: number;
}

export interface DelayGate {
    type: 'delay';
    /** 1..86400 秒 */
    delay_sec: number;
}

export type Gate = RegexGate | EventGate | ActiveTimeGate | TimerGate | UserGate | CounterGate | ProbGate | DelayGate;

/** 规则来源：AI 工具创建 / 单触发 timer 的隐式模式规则 */
export type RuleSource = 'ai' | 'mode';

export interface RuleScope {
    /** 平台白名单（空=不限） */
    platforms?: string[];
    /** 会话白名单（UNI 会话 id）；自主源（active_time/timer）必填 */
    sessions?: string[];
    /** 排除会话 */
    exclude?: string[];
}

export interface RuleLimits {
    /** 总触发次数上限；-1 无限 */
    max_triggers: number;
    /** 过期时间（unix 毫秒）；0 不过期 */
    expire_at: number;
}

export interface TriggerRule {
    id: string;
    enabled: boolean;
    source: RuleSource;
    createdAt: number;
    /** 唤醒文本候选（1~10 条，fire 随机一条）；timer 源门规则的文本来自门内 prompts，可为空 */
    wake_prompts: string[];
    gates: Gate[];
    scope: RuleScope;
    limits: RuleLimits;
}

/** 规则内 count 门/规则进度的持久化分片（按 ruleId+sessionId） */
export interface RuleGateState {
    count: number;
    lastPassAt: number;
}

export interface RuleStateShard {
    /** 已触发次数 */
    fired: number;
    /** 最近触发时间（毫秒） */
    lastFiredAt: number;
    /** 门内计数（index → 计数），只对 counter 门有意义 */
    gates?: Record<string, RuleGateState>;
}

/** 求值输入（只读，pipeline 从消息/事件/调度上下文构造） */
export interface GateInput {
    sessionId: string;
    now: number;
    /** 消息文本（regex 门用；格式为 formatMessageSegmentsForMatching 的输出） */
    text?: string;
    /** 事件视图（event 门用；结构由 event/trigger 定义） */
    event?: { eventType: string; sid: string; eventText?: string; [key: string]: unknown };
    /** 发送者 UNI-ID（user 门用） */
    userId?: string;
    /** 当前所在平台 */
    platform?: string;
    /** 随机源（prob 门；注入便于单测） */
    random?: () => number;
    /** 规则进度分片（counter 门的持久计数） */
    state?: RuleStateShard;
    /** 自主源（active_time/timer）到点后由调度器置 true：timer 门靠它放行，active_time 门则跳过窗口复核 */
    sourceSatisfied?: boolean;
}

/** 门求值产生的增量（只在整链成功起轮时统一提交） */
export interface GateDelta {
    /** 门下标 */
    index: number;
    /** counter 门：通过后的新计数（0=归零） */
    counter?: number;
}

export type GateEvalResult =
    | { status: 'pass'; deltas: GateDelta[] }
    | { status: 'fail'; index: number; reason: string }
    | { status: 'suspend'; index: number; delaySec: number };

/** 规则求值结果（单条规则，不含起轮/存储副作用） */
export type RuleEvalResult =
    | { status: 'pass'; rule: TriggerRule; deltas: GateDelta[] }
    | { status: 'fail'; rule: TriggerRule; index: number; reason: string }
    | { status: 'suspend'; rule: TriggerRule; index: number; delaySec: number }
    | { status: 'skip'; rule: TriggerRule; reason: string };
