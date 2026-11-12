// 知识库预热（装配期调用）。
//
// #163 D1-10：原 `core:skills` / `core:knowledge` 两段会枚举当前技能/知识库清单，
// 清单随配置与安装变化 ⇒ system 中部每轮漂移。两段已改为常量说明段
//（`texts/en.ts` 的 `SKILLS_GUIDANCE` / `KNOWLEDGE_GUIDANCE`，在 `sections/tools.ts` 的
//  `registerDiscoverySections()` 注册）。本文件只保留知识库预热入口，builder 仍在调用。
import { getPromptMemorySource } from '../memory_source';

/** 供 builder 在组装前预热知识库（幂等） */
export async function initKnowledgeBase(): Promise<void> {
    await getPromptMemorySource().initKnowledge();
}
