// Prompt 段类型：注册表 / 组装器 / 段实现共用的纯类型（无运行时依赖）。
import type { InjectionItem } from "../context/injections";   // L1 → L0，仅类型
import type { Session } from "../session/session";
import type { GroupInfo, UserInfo } from "../session/types";

/** 段输出通道：system = 稳定前缀；runtime = 每轮易变（以 user 消息注入） */
export type PromptChannel = 'system' | 'runtime';

/** 注册来源：core/tool = 内置；extension = 外部插件 */
export type SectionScope = 'core' | 'extension';

/** 清洗策略：trusted 原样输出（内置文案），external 剥离内部标签（用户/外部数据） */
export type SanitizePolicy = 'trusted' | 'external';

/** 一次组装时的开关快照 */
export interface PromptFlags {
    /** 「开启调用函数功能」 */
    status: boolean;
    /** 「切换为提示词工程」 */
    promptEngineering: boolean;
    /** 「工具方向提示」 */
    directionPrompt: boolean;
    /** 「接收图片」 */
    receiveImage: boolean;
    /** 「额外消息分隔符」提示词展示写法（模板非空项；空 = 仅内置 \f） */
    extraSeparator: string[];
    /**
     * 图片相关**能力**开关：接收图片 || 图库能力（图床/资源段）。
     * 由 builder 从 aux 适配器元数据派生（方案 v1.4 §10.5），不再直接判 ImageHost/MCP。
     */
    imageUsage: boolean;
    /** 资源清单注入：资源页开关 && 存在 resource 片段（默认关） */
    resourceLibrary: boolean;
    /** 图床提示注入：图片页开关 && 存在 image-host 片段（默认开） */
    imageHost: boolean;
    /** 资源清单段字符预算（配置「资源清单预算」，缺省 600） */
    resourceBudget: number;
    /** 图床提示段字符预算（配置「图床提示预算」，缺省 600） */
    imageHostBudget: number;
    /**
     * 兼容旧字段（下一版删除）：旧「图床或 MCP 启用」。
     * 新段只用 imageHost/resourceLibrary/imageUsage，不再读本字段。
     */
    imageLibrary: boolean;
    /** 记忆总开关 */
    memory: boolean;
    /** 知识库开关 */
    knowledge: boolean;
}

/** 组装上下文（只读）：由 builder 构造，段 build 只读此对象 */
export interface PromptContext {
    ctx: seal.MsgContext;
    session: Session;
    roleSetting: string;
    /** 全局提示词（所有角色共用；空 = 不注入） */
    globalPrompt: string;
    roleIndex: number;
    platform: string;
    isPrivate: boolean;
    sessionName: string;
    sessionId: string;
    botId: string;
    flags: PromptFlags;
    /** 工具在当前会话是否真实可用（已开启 + 平台匹配 + 会话类型匹配） */
    tool(name: string): boolean;
    /** 记忆检索输入（最近用户发言拼接，≤2000 字符） */
    memoryQuery: string;
    /** 最近发言者（群聊记忆注入用） */
    memoryUsers: UserInfo[];
    /** 当前群信息（私聊为 null） */
    memoryGroup: GroupInfo | null;
}

/** 段级缓存：deps 参与 key，任一变化即重建 */
export interface SectionCacheSpec {
    /** 缓存 TTL（毫秒），缺省 30_000 */
    ttlMs?: number;
    deps?: (c: PromptContext) => Array<string | number | boolean>;
}

/** 一个提示词段 */
export interface PromptSection {
    /** 段名：core:* / tool:* / ext:<plugin>:<id> */
    name: string;
    /** 排序值：升序；同值按 name 排序 */
    order: number;
    /** 输出通道 */
    channel: PromptChannel;
    /** 注册来源，缺省 core */
    scope?: SectionScope;
    /** 全局预算紧张时是否可整段丢弃 */
    optional?: boolean;
    /** 单段字符上限，超出截断并记日志 */
    maxChars?: number;
    /** 清洗策略，缺省 trusted */
    sanitize?: SanitizePolicy;
    /** 段级缓存（不配置则每次重建） */
    cache?: SectionCacheSpec;
    /** 构建段文本；返回空串表示本段不可见（门控未通过） */
    build(c: PromptContext): string | Promise<string>;
}

/** 单段统计 */
export interface SectionStat {
    name: string;
    order: number;
    channel: PromptChannel;
    chars: number;
    /** 约算 token（chars / 3 向上取整） */
    tokens: number;
    cache: 'hit' | 'miss' | 'none';
}

/** 一次组装结果 */
export interface PromptParts {
    system: string;
    runtime: string;
    stats: SectionStat[];
    /** system + runtime 的稳定短哈希，用于日志/缓存排障 */
    digest: string;
}

// —— 增量注入（#163 D3）——

/**
 * provider 的只读输入：**不含**任何写入口与归档水位（REQ-D3-03 的类型级保证）。
 *
 * 结构上刻意不提供 `session.context.store` / `head` / `archivedThrough`：
 * provider 只能"产出候选条目"，去重/预算/写块/定位/渲染/记账/释放全部由框架负责。
 */
export interface InjectionContext {
    ctx: seal.MsgContext;
    session: Session;
    /** 只读开关快照（与 PromptFlags 同源） */
    flags: PromptFlags;
    isPrivate: boolean;
    sessionId: string;
    /** 记忆检索输入（同 PromptContext.memoryQuery） */
    query: string;
    users: UserInfo[];
    group: GroupInfo | null;
    /**
     * 上次编译覆盖到的最大 seq（= lastSelectedSeq；框架拿它做 afterSeq，provider 只读）。
     * **不是**"上一次请求的时刻"，是"已发送区最后一字节的位置"。
     */
    lastSentSeq: number;
    /**
     * 本轮冻结的当前时刻（毫秒，`Date.now()` 在**起轮时取一次**后传入）。
     *
     * 必须是值不是函数：provider 内部每次现取 `Date.now()` 会让同一轮两次 `build()` 结果不同
     * ⇒ 破坏 R2（同一快照两次编译字节必须一致）。
     */
    now: number;
    /** 上一次真正回复的 seq（0 = 从未回复）；`core:time` 的去重键 `time:<lastReplySeq>` 靠它 */
    lastReplySeq: number;
    /** 上一次真正回复的时刻（毫秒，0 = 从未回复） */
    lastReplyAt: number;
    /**
     * 当前**活动块**里的条目键集合（只读）。
     *
     * 缺了它 provider 无法判"这条已经注入过"，只能每轮返回同样的条目 ⇒
     * 框架层去重仍会拦住（`dup`），但会白白走一遍全量构建；更糟的是 provider 自己算的
     * 阈值类逻辑（如"距上次回复 > 1h 才注入"）会重复产生同 key 不同正文。
     */
    listActiveKeys(): ReadonlySet<string>;
    /** 文本 token 估算（统一口径：utils/token_estimate.estimateTextTokens） */
    estimateTokens(text: string): number;
}

/** 一个注入 provider（内置/扩展统一形态；见 REQ-D3-01/02） */
export interface InjectionProvider {
    /** 命名空间：core:time / core:memory / core:mcp / core:wake / ext:<plugin>:<id> */
    name: string;
    /** 同轮调度顺序（升序；扩展固定 ≥ 10000） */
    order: number;
    /** 类型：决定去重集合与释放粒度 */
    kind: string;
    /** 失败是否可跳过（内置缺省 false，扩展缺省 true） */
    optional?: boolean;
    /** 只产候选条目；去重/预算/写块/定位/渲染/记账/释放全部由框架负责 */
    build(c: InjectionContext): InjectionItem[] | Promise<InjectionItem[]>;
}

/** 一轮的注入产出：同一 provider 一轮一个 draft；框架按 kind 合并成一个块 */
export interface InjectionDraft {
    kind: string;
    /** core = 内置；extension = 外部插件（单块字符上限 2000） */
    scope?: 'core' | 'extension';
    items: InjectionItem[];
    /** Σ estimateTokens(text) + INJECTION_WRAP_TOKENS（由框架算，provider 不填） */
    tokens: number;
}
