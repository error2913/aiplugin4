// 模型类型定义
export type ChatModelUse = 'chat' | 'compression' | 'summarization' | 'judge';
export type MultimodalModelUse = 'image-understanding' | ChatModelUse;
export type EmbeddingModelUse = 'text-embedding';
/** 媒体生成用途：tts=语音合成，image-generation=文生图（由「模型规则」use 声明） */
export type MediaModelUse = 'tts' | 'image-generation';
export type ModelUse = ChatModelUse | MultimodalModelUse | EmbeddingModelUse | MediaModelUse;

/** 媒体用途判定（供用量跳过、请求路径选择等复用） */
export function isMediaUse(use: ModelUse | string): use is MediaModelUse {
    return use === 'tts' || use === 'image-generation';
}

export interface ModelBody {
    max_tokens?: number,
    stop?: string[] | null,
    stream?: boolean,
    temperature?: number,
    top_p?: number,
    [key: string]: any
}
