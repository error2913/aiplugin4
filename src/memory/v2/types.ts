// Hindsight-like 记忆引擎类型定义（纯 TS 自研，无外部服务）
// 参考 Hindsight 的 MemoryUnit / Entity / MemoryLink / Observation / MentalModel 结构
// 但按本仓库 SealDice 场景裁剪为可持久化 JSON 的版本。

export type FactType = 'world' | 'experience' | 'observation';
export type MemoryState = 'valid' | 'invalidated';
export type ConsolidationState = 'pending' | 'done' | 'failed';
export type BankKind = 'user' | 'group' | 'global';

export interface MemoryBankMeta {
    id: string;
    kind: BankKind;
    agentName?: string;
    sessionId?: string;
    createdAt: number;
    updatedAt: number;
    settings: {
        retainMission?: string;
        observationsMission?: string;
        disposition?: {
            skepticism: number;
            literalism: number;
            empathy: number;
        };
        directives?: Array<{
            name: string;
            content: string;
            tags?: string[];
        }>;
        /** 距上次巩固的观察次数（驱动「每隔多少次观察整合一次记忆」配置） */
        consolidateSince?: number;
        /** 固定心智模型模板已播种版本：推进后删除内置模型不会自动复活，版本升级只增量补新 */
        seededMentalModelVersion?: number;
    };
}

export interface MemoryUnit {
    id: string;
    bankId: string;
    documentId?: string;
    text: string;
    context?: string;
    factType: FactType;
    occurredStart?: number;
    occurredEnd?: number;
    mentionedAt?: number;
    createdAt: number;
    updatedAt: number;
    embedding: number[];
    entityIds: string[];
    tags: string[];
    metadata: Record<string, string>;
    importance: number;
    accessCount: number;
    lastAccessedAt: number;
    state: MemoryState;
    consolidationState: ConsolidationState;
    consolidatedAt?: number;
}

export interface MemoryEntity {
    id: string;
    bankId: string;
    canonicalName: string;
    aliases: string[];
    entityType?: string;
    metadata: Record<string, string>;
    firstSeen: number;
    lastSeen: number;
    mentionCount: number;
}

export type MemoryLinkType =
    | 'entity'
    | 'semantic'
    | 'temporal'
    | 'causes'
    | 'caused_by'
    | 'enables'
    | 'prevents';

export interface MemoryLink {
    fromUnitId: string;
    toUnitId: string;
    linkType: MemoryLinkType;
    entityId?: string;
    weight: number;
    createdAt: number;
}

export interface ObservationEvidence {
    memoryId: string;
    quote: string;
}

export interface ObservationHistoryEntry {
    text: string;
    reason: 'created' | 'reinforced' | 'refined' | 'contradicted' | 'merged';
    at: number;
}

/** 心智模型刷新触发方式：full=基于全部记忆重新推理，delta=增量更新 */
export type MentalModelTrigger = 'full' | 'delta';

/** 固定心智模型模板标识：persona=设定 / preference=偏好 / rules=规则 */
export type MentalModelTemplateId = 'persona' | 'preference' | 'rules';

/** 心智模型生命周期状态：ready=可用，pending=占位待生成，failed=上次生成失败 */
export type MentalModelStatus = 'ready' | 'pending' | 'failed';

/** 心智模型刷新触发配置（Hindsight MentalModelTrigger 的 TS 裁剪版） */
export interface MentalModelTriggerConfig {
    /** 刷新方式：full=基于全部记忆重新推理，delta=只按新增记忆增量更新 */
    mode: MentalModelTrigger;
    /** 巩固后是否自动刷新（对应 Hindsight refresh_after_consolidation） */
    refreshAfterConsolidation: boolean;
    /** 刷新时读取的记忆类型，缺省=全部（world/experience/observation） */
    factTypes?: FactType[];
    /** 刷新时排除其它心智模型，避免模型间互相引用（Hindsight exclude_mental_models） */
    excludeMentalModels?: boolean;
}

export interface MentalModelHistoryEntry {
    answer: string;
    at: number;
    trigger: MentalModelTrigger;
}

export interface Observation {
    id: string;
    bankId: string;
    text: string;
    scopeTags: string[];
    evidence: ObservationEvidence[];
    proofCount: number;
    createdAt: number;
    updatedAt: number;
    lastVerifiedAt: number;
    history: ObservationHistoryEntry[];
}

export interface MentalModel {
    id: string;
    bankId: string;
    question: string;
    answer: string;
    scopeTags: string[];
    createdAt: number;
    updatedAt: number;
    version: number;
    /** 最近一次基于记忆重新推理的时间（秒） */
    lastRefreshedAt: number;
    /** 历史答案（每次 refresh 前压入旧答案，最多保留 10 条） */
    history: MentalModelHistoryEntry[];
    /** 最近一次刷新方式：full=全量重推理，delta=增量更新 */
    trigger: MentalModelTrigger;
    /** 刷新触发配置（mode/自动刷新/读取类型/排除其它模型） */
    triggerConfig?: MentalModelTriggerConfig;
    /** 生命周期状态：pending=占位待生成，failed=上次生成失败 */
    status?: MentalModelStatus;
    /** watermark：上次刷新见过的最新 in-scope 记忆时间（秒），用于 staleness gating */
    lastMemorySeenAt?: number;
    /** 上次生成失败时间（秒），用于失败重试冷却 */
    lastFailedAt?: number;
    /** (question+answer) 语义向量，用于注入语义排序与 searchMentalModels 召回 */
    embedding?: number[];
    /** 内置模板标记；未设置=用户自定义心智模型 */
    templateId?: MentalModelTemplateId;
}

export interface MemoryDocument {
    id: string;
    bankId: string;
    originalText: string;
    contentHash: string;
    createdAt: number;
    metadata: Record<string, string>;
}

export interface MemoryChunk {
    id: string;
    documentId: string;
    bankId: string;
    text: string;
    embedding?: number[];
}

export interface PersistedBank {
    meta: MemoryBankMeta;
    units: MemoryUnit[];
    entities: MemoryEntity[];
    links: MemoryLink[];
    observations: Observation[];
    mentalModels: MentalModel[];
    documents: MemoryDocument[];
    chunks: MemoryChunk[];
}

export interface RetainInput {
    content: string;
    context?: string;
    tags?: string[];
    metadata?: Record<string, string>;
    documentId?: string;
    timestamp?: number;
    /** 是否直接按原文入库（跳过 LLM 抽取）。默认 true，便于工具/迁移使用。 */
    verbatim?: boolean;
    entities?: string[];
    factType?: FactType;
    occurredStart?: number;
    occurredEnd?: number;
    importance?: number;
}

export interface ExtractedFact {
    text: string;
    factType?: FactType;
    entities?: string[];
    occurredStart?: number;
    occurredEnd?: number;
    importance?: number;
    context?: string;
}

export type FactExtractor = (input: RetainInput) => Promise<ExtractedFact[]>;

export type Reranker = (query: string, candidates: MemoryUnit[]) => Promise<string[]>;

export type ObservationSynthesizer = (quotes: string[]) => Promise<string>;

/** 心智模型推理合成器：基于问题与相关记忆（心智模型/观察/事实）生成结论文本。 */
export type ReflectSynthesizer = (query: string, context: {
    mentalModels: MentalModel[];
    observations: Observation[];
    memories: MemoryUnit[];
    /** delta 模式：待增量更新的旧答案（full 模式为空） */
    existingAnswer?: string;
    /** 本次合成方式：full=全量重写，delta=增量更新 */
    mode?: MentalModelTrigger;
}) => Promise<string>;

export interface RetainResult {
    unitIds: string[];
    documentId?: string;
    action: 'added' | 'merged' | 'updated' | 'noop';
}

export interface RecallOptions {
    query: string;
    tags?: string[];
    tagsMatch?: 'any' | 'all' | 'exact';
    types?: FactType[];
    maxTokens?: number;
    budget?: 'low' | 'mid' | 'high';
    includeChunks?: boolean;
    preferObservations?: boolean;
}

export interface RecallResult {
    unit: MemoryUnit;
    score: number;
    matchedStrategies: string[];
    chunks?: MemoryChunk[];
}

export interface ConsolidationResult {
    created: string[];
    updated: string[];
    merged: string[];
    skipped: number;
}

export interface ReflectResult {
    text: string;
    basedOn: {
        mentalModels: MentalModel[];
        observations: Observation[];
        memories: MemoryUnit[];
    };
}

/** 心智模型刷新触发来源 */
export type MentalModelRefreshReason = 'consolidate' | 'manual' | 'tick' | 'create';

/** 心智模型批量刷新结果（Hindsight 语义：updated 推进 watermark；skipped 不调 LLM；failed 保留旧答案） */
export interface MentalModelRefreshSummary {
    updated: number;
    skipped: number;
    failed: number;
    /** 跳过原因计数，便于调试：no_source/not_stale/unchanged/failed_cooldown */
    skippedReasons: Record<string, number>;
    refreshedIds: string[];
}
