// 记忆检索内置常量（原「默认向量相似度」配置，改为硬编码）
export const VECTOR_SIMILARITY = 0.8;

// 三因子打分权重（recency 新鲜度 / importance 重要性 / relevance 相关性），和为 1
export const MEMORY_SCORE_RECENCY_WEIGHT = 0.3;
export const MEMORY_SCORE_IMPORTANCE_WEIGHT = 0.4;
export const MEMORY_SCORE_RELEVANCE_WEIGHT = 0.3;

// 核心事实常驻注入：类型须为语义记忆，且 importance 达到阈值
export const CORE_FACT_IMPORTANCE = 0.8;

// stale 记忆治理：低重要性且长期未访问 → 标记 stale（移出检索）；stale 后再超期 → 删除
export const STALE_IMPORTANCE_THRESHOLD = 0.3;
export const STALE_MARK_DAYS = 30;
export const STALE_DELETE_DAYS = 60;

// 总结条目合并相似度阈值（n-gram 最小集归一化）
export const SUMMARY_MERGE_THRESHOLD = 0.8;
