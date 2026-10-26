// 记忆引擎统一出口：默认 SealDice 持久化；测试可注入内存存储/回调。
import Config from "../../config/config";
import Model from "../../model/model";
import { getMemoryEngineInstance, setMemoryEngineFactory } from "../service";

import { MemoryEngine } from "./engine";
import { defaultDeltaOperator, defaultObservationDecisionMaker, defaultObservationSynthesizer, defaultReflectSynthesizer, defaultReranker } from "./llm";
import { setObservationStaleDays } from "./prompt";
import { getDefaultMemoryStorage, InMemoryMemoryStorage } from "./storage";
import type { MemoryStorage } from "./storage";

export { MemoryEngine } from "./engine";
export { MemoryRepository } from "./repository";
export { InMemoryMemoryStorage, SealMemoryStorage, setDefaultMemoryStorage, getDefaultMemoryStorage } from "./storage";
export * from "./types";
export * from "./prompt";
export * from "./templates";
export { MemoryService } from "../service";

function flag(key: string, fallback: boolean): boolean {
    const value = (Config.memory as unknown as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : fallback;
}
function int(key: string, fallback: number): number {
    const value = (Config.memory as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function createMemoryEngine(): MemoryEngine {
    const embeddingModel = (() => {
        const dimension = Model.getEmbeddingDimension();
        return dimension > 0 ? Model.getEmbeddingModel("text-embedding") : null;
    })();
    const engine = new MemoryEngine({
        storage: getDefaultMemoryStorage(),
        embedding: embeddingModel ? (text: string) => embeddingModel.callEmbedding(text) : undefined,
    });
    if (flag('LLM_RERANK', false)) engine.setReranker(defaultReranker);
    if (flag('OBSERVATION_ENABLED', true)) {
        engine.setObservationSynthesizer(defaultObservationSynthesizer);
        engine.setObservationDecision(defaultObservationDecisionMaker);
    }
    if (flag('LLM_REFLECT_SYNTH', true)) engine.setReflectSynthesizer(defaultReflectSynthesizer);
    engine.setDeltaOps(defaultDeltaOperator);
    engine.setRefreshMinInterval(int('MM_MIN_REFRESH_INTERVAL_SEC', int('MM_MIN_REFRESH_INTERVAL_MIN', 0) * 60));
    engine.setMentalModelDefaults({
        mode: (Config.memory as any).MM_MODE === 'delta' || (Config.memory as any).MM_DEFAULT_MODE === 'delta' ? 'delta' : 'full',
        excludeMentalModels: (Config.memory as any).MM_EXCLUDE_SIBLINGS !== false,
    });
    engine.setMemoryCap(int('MEMORY_MAX_FACTS', 300));
    engine.setSemanticThreshold(Number((Config.memory as any).RECALL_SEMANTIC_MIN_SIM) > 0 ? Number((Config.memory as any).RECALL_SEMANTIC_MIN_SIM) : 0.35);
    engine.setMentalModelLimits({
        maxTokens: int('MM_MAX_TOKENS', 2048),
        failedCooldownSec: int('MM_FAILED_COOLDOWN_MIN', 30) * 60,
        deltaFullRebuildSec: int('MM_DELTA_FULL_REBUILD_HOURS', 48) * 3600,
    });
    setObservationStaleDays(int('OBSERVATION_STALE_DAYS', 90));
    engine.setRecency(Number((Config.memory as any).RECALL_RECENCY_WEIGHT ?? 0.4), int('RECALL_RECENCY_HALF_LIFE_DAYS', 60));
    return engine;
}

setMemoryEngineFactory(createMemoryEngine);

export function getMemoryEngine(): MemoryEngine {
    return getMemoryEngineInstance() as MemoryEngine;
}

export function resetMemoryEngineForTest(storage?: MemoryStorage): void {
    const engine = new MemoryEngine({ storage: storage || new InMemoryMemoryStorage() });
    setMemoryEngineFactory(() => engine);
}
