// memory 子目录工具注册统一入口（记忆 + 知识库）
import Tool from "../../tool";

import { registerKnowledgeTools as registerKnowledgeToolSet } from "./tool_knowledge";
import { registerMemory } from "./tool_memory";

/** 注册 memory 下全部记忆工具（分类：记忆） */
export function registerMemoryTools() {
    Tool.withCategory('记忆', registerMemory);
}

/** 注册知识库工具（来源分组=知识库，不参与工具组维度，由 .ai kb 管理会话开关） */
export function registerKnowledgeTools() {
    registerKnowledgeToolSet();
}
