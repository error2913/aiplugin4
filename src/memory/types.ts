// 记忆类型定义
import MemoryItem from "./memory_item";

export interface searchOptions {
    topK: number;
    tags: string[];
    relatedMemories: string[];
    users: string[];
    groups: string[];
    method: 'importance' | 'similarity' | 'score' | 'early' | 'late' | 'recent';
    /** 严格用户过滤：非空时记忆须命中至少一个用户（users 为宽松过滤，条目为空视为全局可见） */
    filterUsers?: string[];
    /** 严格群组过滤：非空时记忆须命中至少一个群组（groups 为宽松过滤，条目为空视为全局可见） */
    filterGroups?: string[];
    /** 当前会话 ID：私有记忆仅对创建会话可见 */
    sessionId?: string;
}
export interface MemorySource {
    source: string;
    memories: MemoryItem[];
}
