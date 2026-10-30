// 触发域元数据（L0，唯一事实源）：模式顺序/别名/类别、触发页配置键顺序、默认开启集。
//
// 为什么集中在一个 L0 文件：配置页顺序、`.ai trg` 总览、`.ai status`、help、文档、
// Setting 默认值都依赖同一份顺序与默认值；分散在 L2 的 trigger 与 config 两处会形成
// 「两个事实源」并在 deps 图上产生同层反向依赖（见方案 §3.1 C1/C5、§9.2）。
// 本文件只放数据，不放实现：任何消费者（trigger/modes_meta、configs/trigger、
// cmd/sub_cmd/trg_modes、Setting 构造默认）都从这里派生。

/** 单触发模式 token（按 token 字母序，即展示顺序）。`at` 已改为触发页配置开关，不再是命令模式 */
export const MODE_TOKENS = [
    'active',
    'counter',
    'delay',
    'event',
    'judge',
    'prob',
    'regex',
    'timer',
] as const;

export type ModeToken = typeof MODE_TOKENS[number];

export interface ModeMeta {
    /** 命令 token（`.ai trg <token>`） */
    token: ModeToken;
    /** 别名：命令行可写的简写（`@` 也接受） */
    aliases: string[];
    /** 中文标签（命令总览/配置页/文档共用） */
    label: string;
    /** `on` 参数类型：toggle=无参数开关；valued=需要一个数值；configured=由全局配置驱动（传值拒绝） */
    kind: 'toggle' | 'valued' | 'configured';
    /** 是否可作为门控链的「源门」类型（judge/at 不支持） */
    gateSupported: boolean;
    /** 对应触发页配置键（没有独立键的为 null） */
    configKey: TriggerConfigKey | null;
    /** 说明（`.ai trg` 详情/help 用） */
    desc: string;
}

/** 触发页配置键 id（真正注册到海豹显示名见 TRIGGER_CONFIG_KEYS） */
export type TriggerConfigKey =
    | 'triggerCondition'
    | 'bucketLimit'
    | 'bucketFillInterval'
    | 'activeTime'
    | 'atTrigger'
    | 'counter'
    | 'timer'
    | 'eventRules'
    | 'judgeToml'
    | 'prob'
    | 'regexTemplate'
    | 'timerToml';

export interface TriggerConfigKeyMeta {
    id: TriggerConfigKey;
    /** 海豹配置显示名（注册/读取都用它） */
    name: string;
    /** 海豹配置控件类型 */
    type: 'string' | 'int' | 'float' | 'template' | 'boolean';
    /** 是否本次新增键（旧版没有） */
    isNew: boolean;
    /** 关联模式（全局键为 null） */
    mode: ModeToken | null;
    /** 生效方式：动态（≤60s）/ 重载（改后需重载 JS） */
    refresh: 'dynamic' | 'reload';
    /** 默认值（仅供文档/单测对照；实际注册值以 configs/trigger.ts 为准） */
    default: string | number | boolean | string[];
}

/**
 * 触发页 12 键唯一顺序（注册顺序 = WebUI 顺序）。
 * 3 个全局键前置，随后按语义：活跃时间 → **被@触发（开关）** → 其余按模式 token 字母序。
 * `at` 是配置开关，不是 `.ai trg` 命令模式。
 */
export const TRIGGER_CONFIG_KEYS: TriggerConfigKeyMeta[] = [
    { id: 'triggerCondition', name: '触发需要满足的条件', type: 'string', isNew: false, mode: null, refresh: 'dynamic', default: '1' },
    { id: 'bucketLimit', name: '触发次数上限', type: 'int', isNew: false, mode: null, refresh: 'dynamic', default: 3 },
    { id: 'bucketFillInterval', name: '触发次数补充间隔', type: 'int', isNew: false, mode: null, refresh: 'dynamic', default: 3 },
    { id: 'activeTime', name: '触发活跃时间', type: 'template', isNew: true, mode: 'active', refresh: 'dynamic', default: [''] },
    { id: 'atTrigger', name: '被@触发', type: 'boolean', isNew: true, mode: null, refresh: 'dynamic', default: true },
    { id: 'counter', name: '默认计数器', type: 'int', isNew: false, mode: 'counter', refresh: 'dynamic', default: 10 },
    { id: 'timer', name: '默认计时器', type: 'float', isNew: false, mode: 'delay', refresh: 'dynamic', default: 60 },
    { id: 'eventRules', name: '事件触发规则', type: 'string', isNew: false, mode: 'event', refresh: 'reload', default: '{"version":1,"rules":[]}' },
    { id: 'judgeToml', name: '评分触发参数', type: 'string', isNew: true, mode: 'judge', refresh: 'reload', default: '' },
    { id: 'prob', name: '默认概率', type: 'float', isNew: false, mode: 'prob', refresh: 'dynamic', default: 10 },
    { id: 'regexTemplate', name: '触发正则表达式', type: 'template', isNew: false, mode: 'regex', refresh: 'reload', default: ['^正确.*[。？！?!]$'] },
    { id: 'timerToml', name: '默认定时器', type: 'string', isNew: true, mode: 'timer', refresh: 'dynamic', default: '' },
];

/** 单触发模式元数据（顺序 = MODE_TOKENS；at 已改为配置开关，不在此列表） */
export const MODES: ModeMeta[] = [
    { token: 'active', aliases: ['a'], label: '活跃时间', kind: 'toggle', gateSupported: true, configKey: 'activeTime', desc: '全局活跃时段内自动触发（会话需开启 activeMode）' },
    { token: 'counter', aliases: ['c'], label: '计数器', kind: 'valued', gateSupported: true, configKey: 'counter', desc: '累计消息数达到阈值触发' },
    { token: 'delay', aliases: ['d'], label: '延迟', kind: 'valued', gateSupported: true, configKey: 'timer', desc: '最后一条消息后静默 N 秒触发（原计时器）' },
    { token: 'event', aliases: ['e'], label: '事件', kind: 'toggle', gateSupported: true, configKey: 'eventRules', desc: '事件触发规则（v1 JSON）' },
    { token: 'judge', aliases: ['j'], label: '评分触发', kind: 'toggle', gateSupported: false, configKey: 'judgeToml', desc: '判定管线决定是否主动插话' },
    { token: 'prob', aliases: ['pb'], label: '概率', kind: 'valued', gateSupported: true, configKey: 'prob', desc: '每条消息按概率触发' },
    { token: 'regex', aliases: ['r'], label: '正则', kind: 'toggle', gateSupported: true, configKey: 'regexTemplate', desc: '非指令消息按触发正则触发' },
    { token: 'timer', aliases: ['t'], label: '定时器', kind: 'configured', gateSupported: true, configKey: 'timerToml', desc: '按全局「默认定时器」TOML 计划触发（每个 [[timer]] 一个定时器）' },
];

/** `.ai on` 强制开启的模式（作者拍板：只开正则 + 事件；其它模式开关保持原值） */
export const DEFAULT_ON_MODES: ModeToken[] = ['regex', 'event'];

/** 会话内触发页键名（供读取 Config.trigger 时按 id 取名） */
export function triggerConfigName(id: TriggerConfigKey): string {
    const meta = TRIGGER_CONFIG_KEYS.find(item => item.id === id);
    return meta ? meta.name : id;
}

/** token/别名 → 模式元数据（命令解析用；`@` 走别名） */
export function modeByToken(tokenOrAlias: string): ModeMeta | null {
    const key = String(tokenOrAlias || '').trim().toLowerCase();
    if (!key) return null;
    for (const mode of MODES) {
        if (mode.token === key || mode.aliases.includes(key)) return mode;
    }
    return null;
}

/** 模式 token 字母序排序校验（单测守卫：MODE_TOKENS 必须严格升序） */
export function isModeOrderAlphabetical(): boolean {
    const sorted = [...MODE_TOKENS].sort();
    return MODE_TOKENS.every((token, index) => token === sorted[index]);
}
