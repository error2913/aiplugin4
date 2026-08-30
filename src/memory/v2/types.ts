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
