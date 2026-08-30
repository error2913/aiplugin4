// 模型类型定义
export type ChatModelUse = 'chat' | 'compression' | 'summarization' | 'judge';
export type MultimodalModelUse = 'image-understanding' | ChatModelUse;
export type EmbeddingModelUse = 'text-embedding';
export type ModelUse = ChatModelUse | MultimodalModelUse | EmbeddingModelUse;
export interface ModelBody {
    max_tokens?: number,
    stop?: string[] | null,
    stream?: boolean,
    temperature?: number,
    top_p?: number,
    [key: string]: any
}
