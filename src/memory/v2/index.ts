// 记忆引擎统一出口：默认使用 SealDice 持久化，测试可注入内存存储。
import Config from "../../config/config";
import Model from "../../model/model";

import { MemoryEngine } from "./engine";
import { defaultFactExtractor, defaultObservationSynthesizer, defaultReflectSynthesizer, defaultReranker } from "./llm";
import { getDefaultMemoryStorage, InMemoryMemoryStorage } from "./storage";
import type { MemoryStorage } from "./storage";

export { MemoryEngine } from "./engine";
export { MemoryRepository } from "./repository";
export { InMemoryMemoryStorage, SealMemoryStorage, setDefaultMemoryStorage, getDefaultMemoryStorage } from "./storage";
export * from "./types";
export * from "./bank_resolver";
export * from "./prompt";
export * from "./templates";
export { defaultFactExtractor, defaultReranker, defaultObservationSynthesizer, defaultReflectSynthesizer } from "./llm";

export function createMemoryEngine(): MemoryEngine {
    // 与知识库检索一致：配置了 text-embedding 模型时接入语义向量，未配置时自动降级为关键词/图/时间检索
    const embeddingModel = (() => {
        const dimension = Model.getEmbeddingDimension();
        return dimension > 0 ? Model.getEmbeddingModel("text-embedding") : null;
    })();
    const engine = new MemoryEngine({
        storage: getDefaultMemoryStorage(),
        embedding: embeddingModel ? (text: string) => embeddingModel.callEmbedding(text) : undefined,
    });
    const memoryConfig = Config.memory;
    if (memoryConfig.MEMORY_LLM_EXTRACT) engine.setExtractor(defaultFactExtractor);
    if (memoryConfig.MEMORY_LLM_RERANK) engine.setReranker(defaultReranker);
    if (memoryConfig.MEMORY_OBSERVATION_SYNTH) engine.setObservationSynthesizer(defaultObservationSynthesizer);
    if (memoryConfig.MEMORY_REFLECT_SYNTH) engine.setReflectSynthesizer(defaultReflectSynthesizer);
    if (memoryConfig.MEMORY_REFRESH_MIN_INTERVAL > 0) engine.setRefreshMinInterval(memoryConfig.MEMORY_REFRESH_MIN_INTERVAL * 60);
    // Hindsight 式心智模型刷新：默认模式 / 排除其它模型 / 定时刷新间隔
    engine.setMentalModelDefaults({
        mode: memoryConfig.MEMORY_MM_DEFAULT_MODE === 'delta' ? 'delta' : 'full',
        excludeMentalModels: memoryConfig.MEMORY_MM_EXCLUDE_SIBLINGS,
    });
    // 遗忘机制：长期记忆条数上限（0 为不限制，默认 100）
    engine.setMemoryCap(memoryConfig.MEMORY_CAP);
    // Hindsight 式新近度加权：接入召回排序（权重 0 时关闭）
    engine.setRecency(memoryConfig.MEMORY_RECENCY_WEIGHT, memoryConfig.MEMORY_RECENCY_HALF_LIFE_DAYS);
    return engine;
}

let globalEngine: MemoryEngine | null = null;

export function getMemoryEngine(): MemoryEngine {
    if (!globalEngine) globalEngine = createMemoryEngine();
    return globalEngine;
}

export function resetMemoryEngineForTest(storage?: MemoryStorage): void {
    globalEngine = new MemoryEngine({ storage: storage || new InMemoryMemoryStorage() });
}
