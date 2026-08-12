// memory 子目录工具注册统一入口（记忆 + 知识库）
import { registerKnowledgeTools } from "./tool_knowledge";
import { registerMemory } from "./tool_memory";

/** 注册 memory 下全部记忆工具 */
export function registerMemoryTools() {
    registerMemory();
    registerKnowledgeTools();
}
