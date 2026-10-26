// 记忆 v3 类型（唯一数据模型）：原始事实 / 观察 / 心智模型三层。
// 与 Hindsight 对齐：raw facts append-only、observation evidence/proofCount、mental model sourceQuery/content/structuredContent/trigger/reflectResponse。

export type BankKind = 'user' | 'group' | 'global';
export type FactType = 'world' | 'experience';
export type MemoryState = 'valid' | 'invalidated';
export type ConsolidationState = 'pending' | 'done';
export type Visibility = 'public' | 'origin' | 'owner';
export type TagsMatch = 'any' | 'all' | 'all_strict' | 'exact';

/** 原始事实：只增不改；纠错通过 invalidated + supersedes 表达。 */
export interface MemoryUnit {
    id: string;
    bankId: string;
    text: string;
    factType: FactType;
    occurredStart?: number;
    occurredEnd?: number;
    mentionedAt?: number;
    createdAt: number;
    /** 单调序号：watermark / delta 窗口使用，避免秒级同秒漏记 */
    createdAtSeq: number;
    updatedAt: number;
    embedding: number[];
    entityIds: string[];
    /** scope（user:/group:/global:）+ visibility（vis:*）+ source（src:*）+ keyword（kw:） */
    tags: string[];
    metadata: Record<string, string>;
    importance: number;
    accessCount: number;
    lastAccessedAt: number;
    state: MemoryState;
    invalidatedAt?: number;
    invalidatedBy?: string;
    supersedes?: string;
    consolidationState: ConsolidationState;
    consolidatedAt?: number;
}

export interface MemoryEntity {
    id: string;
    bankId: string;
    canonicalName: string;
    aliases: string[];
    firstSeen: number;
    lastSeen: number;
    mentionCount: number;
}

export type MemoryLinkType = 'entity' | 'semantic' | 'related';

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
    addedAt: number;
}

export type ObservationHistoryReason =
    | 'created'
    | 'reinforced'
    | 'refined'
    | 'contradicted'
    | 'merged'
    | 'invalidated';

export interface ObservationHistoryEntry {
    text: string;
    reason: ObservationHistoryReason;
    at: number;
}

/** 观察：独立一等公民，不再复制为 MemoryUnit。 */
export interface Observation {
    id: string;
    bankId: string;
    text: string;
    tags: string[];
    evidence: ObservationEvidence[];
    /** distinct live source facts；每次折入证据后重算 */
    proofCount: number;
    createdAt: number;
    updatedAt: number;
    /** 最近一次新增/验证证据的时间；用于派生“过期” */
    lastSupportedAt: number;
    status: 'active' | 'invalidated';
    history: ObservationHistoryEntry[];
    embedding?: number[];
}

// ===== 心智模型：结构化文档 + 类型化 delta =====

export type MentalModelTrigger = 'full' | 'delta';
export type MentalModelTemplateId =
    | 'persona'
    | 'preference'
    | 'rules'
    | 'self_rules'
    | 'self_experience';
export type MentalModelStatus = 'ready' | 'pending' | 'failed';
export type MentalModelRefreshReason = 'consolidate' | 'manual' | 'create' | 'seed';

export interface MentalModelTriggerConfig {
    mode: MentalModelTrigger;
    refreshAfterConsolidation: boolean;
    factTypes: FactType[];
    tagsMatch: TagsMatch;
}

export type StructuredBlockType = 'paragraph' | 'bullet' | 'checklist' | 'code';

export interface StructuredBlock {
    id: string;
    type: StructuredBlockType;
    text: string;
}

export interface StructuredSection {
    id: string;
    heading: string;
    blocks: StructuredBlock[];
}

export interface StructuredDoc {
    version: 1;
    sections: StructuredSection[];
}

export interface MentalModelHistoryEntry {
    content: string;
    at: number;
    trigger: MentalModelTrigger | 'manual' | 'seed';
}

export interface MentalModelReflectResponse {
    at: number;
    basedOn: {
        mentalModelIds: string[];
        observationIds: string[];
        memoryIds: string[];
    };
    skipped?: 'empty_candidate' | 'llm_error' | 'no_memory' | 'source_query_changed';
}

export interface MentalModel {
    id: string;
    bankId: string;
    /** 原 question：refresh 时用 sourceQuery 重新做 reflect */
    sourceQuery: string;
    content: string;
    structuredContent: StructuredDoc;
    trigger: MentalModelTriggerConfig;
    tags: string[];
    maxTokens: number;
    status: MentalModelStatus;
    createdAt: number;
    updatedAt: number;
    lastRefreshedAt: number;
    lastFullRefreshAt: number;
    lastRefreshedSourceQuery: string;
    /** 上次刷新见过的 scope 内最新 fact/observation seq（watermark） */
    lastMemorySeenSeq: number;
    lastFailedAt?: number;
    reflectResponse?: MentalModelReflectResponse;
    history: MentalModelHistoryEntry[];
    embedding?: number[];
    templateId?: MentalModelTemplateId;
}

// ===== Bank / 持久化 =====

export interface MemoryBankMeta {
    id: string;
    kind: BankKind;
    agentName?: string;
    /** 原始平台会话 ID（不带 bank 前缀）；global 为空 */
    sessionId?: string;
    createdAt: number;
    updatedAt: number;
    schemaVersion: 3;
    settings: {
        seededMentalModelVersion?: number;
        nextFactSeq?: number;
        /** 调度器 tick 只读此计数，不解析 units */
        pendingFactCount?: number;
        lastExtractAt?: number;
        lastConsolidateAt?: number;
        lastAutoRefreshAt?: number;
    };
}

export interface PersistedBank {
    meta: MemoryBankMeta;
    units: MemoryUnit[];
    entities: MemoryEntity[];
    links: MemoryLink[];
    observations: Observation[];
    mentalModels: MentalModel[];
}

// ===== 输入/输出 =====

export interface RetainInput {
    content: string;
    tags?: string[];
    metadata?: Record<string, string>;
    timestamp?: number;
    factType?: FactType;
    entities?: string[];
    occurredStart?: number;
    occurredEnd?: number;
    importance?: number;
    /** 被本事实取代的旧事实 id（纠错链） */
    supersedes?: string;
    /** private 语义映射到 owner 可见性 */
    visibility?: 'public' | 'private' | 'origin' | 'owner';
}

export interface RetainResult {
    unitIds: string[];
    action: 'added' | 'duplicate' | 'noop';
}

export interface RecallOptions {
    query: string;
    tags?: string[];
    tagsMatch?: TagsMatch;
    types?: FactType[];
    maxTokens?: number;
    budget?: 'low' | 'mid' | 'high';
    /** 只取 createdAtSeq > 该值的证据（delta 窗口） */
    createdAfterSeq?: number;
    includeInvalidated?: boolean;
    /** 用覆盖该事实的 active observation 替换事实，且观察只出现一次 */
    collapseObservations?: boolean;
}

export interface RecallHit {
    kind: 'fact' | 'observation';
    unit?: MemoryUnit;
    observation?: Observation;
    score: number;
    matchedStrategies: string[];
}

export interface ExtractOutcome {
    touchedBanks: string[];
    factsAdded: number;
    factsInvalidated: number;
    factsDropped: number;
    touchedTags: string[];
}

export interface ConsolidateOutcome {
    created: string[];
    updated: string[];
    merged: string[];
    skipped: number;
    touchedTags: string[];
    pendingRemaining: number;
}

export interface ObservationDecision {
    action: 'create' | 'reinforce' | 'refine' | 'contradict' | 'merge' | 'noop';
    targetId?: string;
    text?: string;
    evidenceMemoryIds?: string[];
}

export interface RefreshOutcome {
    modelId: string;
    status: 'updated' | 'skipped' | 'failed';
    reason?: string;
}

export interface ReflectResult {
    text: string;
    basedOn: {
        mentalModels: MentalModel[];
        observations: Observation[];
        memories: MemoryUnit[];
    };
    answeredBy?: 'model' | 'synthesis' | 'none';
}

export interface MentalModelRefreshSummary {
    updated: number;
    skipped: number;
    failed: number;
    skippedReasons: Record<string, number>;
    refreshedIds: string[];
}

export interface MemoryStatus {
    bankId: string;
    facts: number;
    invalidated: number;
    pendingFacts: number;
    observations: number;
    expiredObservations: number;
    mentalModels: number;
    pendingMentalModels: number;
    failedMentalModels: number;
    backlog: 'up_to_date' | 'slightly_stale' | 'stale';
    nextRefreshAt?: number;
}

// ===== LLM 回调 =====

export type Reranker = (query: string, candidates: MemoryUnit[]) => Promise<string[]>;
export type ObservationSynthesizer = (quotes: string[]) => Promise<string>;
export type ObservationDecisionMaker = (input: {
    evidence: string[];
    existing: Observation[];
    tags: string[];
}) => Promise<ObservationDecision>;

export interface ReflectSynthesizerContext {
    mentalModels: MentalModel[];
    observations: Observation[];
    memories: MemoryUnit[];
    existingAnswer?: string;
    mode?: MentalModelTrigger;
    scopeNote?: string;
}

export type ReflectSynthesizer = (query: string, context: ReflectSynthesizerContext) => Promise<string>;

export interface DeltaOperation {
    op: 'add_section' | 'append_bullet' | 'replace_block' | 'remove_stale_paragraph' | 'replace_section_blocks';
    sectionId?: string;
    blockId?: string;
    heading?: string;
    blocks?: StructuredBlock[];
    text?: string;
}

export type DeltaOperator = (input: {
    sourceQuery: string;
    structured: StructuredDoc;
    evidence: string[];
}) => Promise<DeltaOperation[]>
