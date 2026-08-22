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
    /** 调用方会话 ID：私有记忆仅对创建会话可见；缺省时取记忆服务所属会话（基类公共记忆为空） */
    sessionId?: string;
}
export interface MemorySource {
    source: string;
    memories: MemoryItem[];
}

/**
 * 记忆事实：由总结智能体/工具产出的原子写入操作。
 * op 决定应用语义：add 新增；update 覆盖（可附 existing_id 精确定位）；
 * delete 删除（附 existing_id）；noop 不写入。
 */
export interface MemoryFact {
    op?: 'add' | 'update' | 'delete' | 'noop';
    existing_id?: string;
    memory_type?: 'private' | 'group';
    target_id?: string;
    type?: MemoryItem['type'];
    text: string;
    keywords?: string[];
    related_user_ids?: string[];
    related_group_ids?: string[];
    related_memory_ids?: string[];
    importance?: number;
    visibility?: 'public' | 'private';
}

/** applyFact 返回结果：动作 + 命中的记忆 ID */
export interface MemoryFactResult {
    action: 'added' | 'merged' | 'updated' | 'deleted' | 'noop';
    id?: string;
}
