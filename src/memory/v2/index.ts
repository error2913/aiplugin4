// 记忆引擎统一出口：默认使用 SealDice 持久化，测试可注入内存存储。
import Config from "../../config/config";

import { MemoryEngine } from "./engine";
import { defaultFactExtractor, defaultObservationSynthesizer, defaultReranker } from "./llm";
import { getDefaultMemoryStorage, InMemoryMemoryStorage } from "./storage";
import type { MemoryStorage } from "./storage";

export { MemoryEngine } from "./engine";
export { MemoryRepository } from "./repository";
export { InMemoryMemoryStorage, SealMemoryStorage, setDefaultMemoryStorage, getDefaultMemoryStorage } from "./storage";
export * from "./types";
export * from "./bank_resolver";
export * from "./prompt";
export { defaultFactExtractor, defaultReranker, defaultObservationSynthesizer } from "./llm";

export function createMemoryEngine(): MemoryEngine {
    const engine = new MemoryEngine({ storage: getDefaultMemoryStorage() });
    const memoryConfig = Config.memory;
    if (memoryConfig.MEMORY_LLM_EXTRACT) engine.setExtractor(defaultFactExtractor);
    if (memoryConfig.MEMORY_LLM_RERANK) engine.setReranker(defaultReranker);
    if (memoryConfig.MEMORY_OBSERVATION_SYNTH) engine.setObservationSynthesizer(defaultObservationSynthesizer);
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

