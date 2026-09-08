// 子代理核心类型定义（DSH 对齐，v4 定稿 docs/12）
// 本模块只含类型与结构，不依赖 seal/Config，可独立单测。
export type SubAgentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | 'timeout';

export interface SubAgentResult {
    stopReason: SubAgentStopReason;
    /** completed 时的最终文本（可能截断） */
    output: string;
    /** 非 completed 时的 provider 诊断 */
    diagnostic?: string;
}

export interface SubAgentRun {
    id: string;
    result: Promise<SubAgentResult>;
    dispose(): Promise<void>;
}

export interface ToolFilter {
    allow?: string[];
    deny?: string[];
}

/** 会话级工具开关快照（toolMap 名的布尔值集合） */
export type ToolState = Record<string, boolean>;

export type ChildStatus = 'running' | 'idle' | 'done' | 'stopped' | 'interrupted';

export interface ChildMeta {
    epId: string;
    isPrivate: boolean;
}

export interface ChildRecord {
    childId: string;
    parentSessionId: string;
    /** 整棵委派树的根会话（主会话）；中断/全停按它归属 */
    treeRootSessionId: string;
    parentAgentName: string;
    provider: string; // 'spawn' | 'fork' | 自定义 provider 名
    label: string;
    depth: number;
    status: ChildStatus;
    childSessionId: string;
    agentName: string;
    meta: ChildMeta;
    createdAt: number;
    updatedAt: number;
    lastResult?: SubAgentResult;
    /** send_message 投递的待处理消息（inbox，continuable 续派） */
    inbox: string[];
    /** 建 child 时的工具面过滤（供续跑重建 child 会话） */
    toolFilter?: ToolFilter | null;
    /** 是否已投过结算 notice（生命周期绑定：只有曾 notice 过才随父上下文遗忘而清理） */
    hasNoticed?: boolean;
    /** 记录结构版本：新记录=2；旧版记录无此字段（未绑定 notice，清扫时按遗留清理） */
    recVer?: number;
}

/** 调用方（父 agent/主会话）的定位信息 */
export interface ParentRef {
    sessionId: string;
    epId: string;
    isPrivate: boolean;
    depth: number;
    /** 整棵委派树根会话；子代理再委派时透传，缺省=自己的 sessionId */
    treeRootSessionId?: string;
}

export interface StartRequest {
    label: string; // 3-5 词展示名
    prompt: string;
    parent: ParentRef;
    /** 由 SubAgentService 分配后回填（provider/executor 用于建立 child 会话与上报） */
    childId?: string;
    childSessionId?: string;
    /** 对接层透传的运行现场（ctx/msg/父 Session 等），opaque；机制层不解析 */
    runtime?: unknown;
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number };
    persona?: string;
    toolFilter?: ToolFilter;
    /** 委派深度上限；0=禁委派。由工具实例配置带入，超限在 start 前拒绝 */
    maxDepth?: number;
}

export interface SubAgentProvider {
    name: string;
    /** fork=true（继承父已完成轮次）、spawn=false（零父上下文）；决定工具文案 */
    inheritsParentContext: boolean;
    /** 前台运行一个 child（完整生命周期直到终态） */
    start(req: StartRequest): Promise<SubAgentRun>;
    /** continuable 能力位：返回后 child 会话独立存活，可被 send_message 续派 */
    prepareContinuable?(req: StartRequest): Promise<{ seed?: unknown }>;
}

/** settle/notice 落点：把一段文本投给父会话（由对接层实现为 noticeQueue push）；childId 供父上下文标记 */
export type SubAgentSettleSink = (parentSessionId: string, text: string, childId?: string) => void;
