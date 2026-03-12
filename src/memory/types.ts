export interface searchOptions {
    topK: number;
    tags: string[];
    relatedMemories: string[];
    users: string[];
    groups: string[];
    method: 'importance' | 'similarity' | 'score' | 'early' | 'late' | 'recent';
}