// Prompt 记忆/知识库数据源端口（叶子）：builder 只依赖本接口，不直接 import memory 模块。
// 这样打断 memory/manager → utils/message → prompt/builder → memory/manager 的请求装配环。
// 实现由组合根（src/index.ts、scripts/test-host.ts）注入；数据仍全部来自 MemoryManager / knowledgeService。
import type { Session } from "../session/session";
import type { GroupInfo, UserInfo } from "../session/types";

export interface PromptMemorySource {
    initKnowledge(): Promise<void>;
    knowledgeSignature(): string;
    knowledgeIds(): string[];
    formatKnowledgeFor(platform: string, enabledIds: Set<string>): string;
    memoryRevision(): number;
    summaryRevision(): number;
    buildLongTermPrompt(ctx: seal.MsgContext, session: Session, text: string, uis: UserInfo[], gi: GroupInfo | null): Promise<string>;
    buildObservationPrompt(session: Session): string;
}

let source: PromptMemorySource | null = null;

export function setPromptMemorySource(next: PromptMemorySource | null): void {
    source = next;
}

export function getPromptMemorySource(): PromptMemorySource {
    if (!source) throw new Error('PromptMemorySource 未初始化：入口需先 installPromptMemorySource()');
    return source;
}
