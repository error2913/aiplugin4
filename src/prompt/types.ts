// Prompt 段类型：注册表 / 组装器 / 段实现共用的纯类型（无运行时依赖）。
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
    /** 图床或 MCP 启用（图片与图库段） */
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
