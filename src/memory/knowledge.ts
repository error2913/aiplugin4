// 知识库服务：兼容导出（实现已迁移到 knowledge_base.ts 单例）
import { knowledgeBase, KnowledgeBaseService } from "./knowledge_base";

export { knowledgeBase as knowledgeService };
export default knowledgeBase;
export { KnowledgeBaseService };
