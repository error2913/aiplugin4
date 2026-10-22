// Prompt 记忆数据源的实现：接到 MemoryManager / knowledgeService / revision。
// 只由组合根导入，避免 prompt 模块重新依赖 memory 模块。
import { knowledgeService } from "../memory/knowledge";
import { MemoryManager } from "../memory/manager";
import { getMemoryRevision, getSummaryRevision } from "../memory/revision";

import { setPromptMemorySource } from "./memory_source";

export function installPromptMemorySource(): void {
    setPromptMemorySource({
        initKnowledge: () => knowledgeService.init(),
        knowledgeSignature: () => knowledgeService.getLibrariesSignature(),
        knowledgeIds: () => knowledgeService.getLibraries().map((lib) => lib.id),
        formatKnowledgeFor: (platform, enabledIds) => knowledgeService.formatLibrariesFor(platform, enabledIds),
        memoryRevision: () => getMemoryRevision(),
        summaryRevision: () => getSummaryRevision(),
        buildLongTermPrompt: (ctx, session, text, uis, gi) => MemoryManager.buildLongTermPrompt(ctx, session, text, uis, gi),
        buildObservationPrompt: (session) => MemoryManager.buildObservationPrompt(session),
    });
}
