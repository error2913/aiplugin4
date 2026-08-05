// 记忆类型定义
import MemoryItem from "./memory_item";

export interface searchOptions {
    topK: number;
    tags: string[];
    relatedMemories: string[];
    users: string[];
    groups: string[];
    method: 'importance' | 'similarity' | 'score' | 'early' | 'late' | 'recent';
}
export interface MemorySource {
    source: string;
    memories: MemoryItem[];
}
