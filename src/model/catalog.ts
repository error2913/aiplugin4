// 模型能力分类：给连接拉取/钉住的模型名打能力标签，供「候选/默认」判定使用。
// 标签语义（供 model/model.ts 使用）：
//   embed —— 文本嵌入模型（只进 text-embedding 候选，绝不进对话候选）
//   gen   —— 图像生成类（本插件不消费，全部排除在候选外）
//   vision—— 支持图像输入（可进对话与 image-understanding 候选）
//   text  —— 普通文本（对话候选）
// 原则：只有能明确分辨的类别才会自动成为默认（embed 白名单/vision 证据或白名单）；
// 未知命名一律归 text 候选，绝不擅自当作 vision/embed 默认。
// 纯模块：不依赖 seal / Config，便于单元测试。

export type ModelTag = 'text' | 'vision' | 'embed' | 'gen';

const GENERIC_EMBED_PATTERNS: RegExp[] = [
    /(^|[^a-z0-9])text-embedding/i,
    /(^|[^a-z0-9])(?:embedding|embed)([^a-z0-9]|$)/i,
    /(^|[^a-z0-9])bge([^a-z0-9]|$)/i,          // BAAI/bge-*、bge-m3
    /bge-large/i,
    /bce-embedding/i,
    /(^|[^a-z0-9])multimodal-embedding/i,
    /(^|[^a-z0-9])gemini-embedding/i,
    /-embed-v\d/i,                              // 阿里 text-embedding-vN 已由 text-embedding 命中，此为兜底命名
    /^mistral-embed$/i,
];

const GENERIC_GEN_PATTERNS: RegExp[] = [
    /dall-e/i,
    /gpt-image/i,
    /cogview/i,
    /wanx/i,
    /^flux/i,
    /stable-diffusion/i,
    /^sd3/i,
    /kolors/i,
    /hunyuan-image/i,
    /^seedream/i,
    /^midjourney/i,
    /^imagen/i,
    /^veo/i,
];

const GENERIC_VISION_PATTERNS: RegExp[] = [
    /(^|[^a-z0-9])pixtral/i,
    /(^|[^a-z0-9])glm-[0-9.]*v([^a-z0-9]|$)/i,
    /(^|[^a-z0-9])qwen.*-vl/i,
    /qwen2(?:\.5)?-vl/i,
    /(^|[^a-z0-9])[a-z0-9.-]*vision/i,
    /(^|[^a-z0-9])[a-z0-9.-]*visual/i,
    /(^|[^a-z0-9])gemini([^a-z0-9]|$)/i,         // Gemini 全系多模态输入
    /(^|[^a-z0-9])gpt-4o/i,
    /(^|[^a-z0-9])gpt-4\.1/i,
    /(^|[^a-z0-9])gpt-5/i,
    /(^|[^a-z0-9])kimi-k2/i,                     // Moonshot 视觉模型族
    /(^|[^a-z0-9])step-[0-9.]*v/i,
];

function matchAny(name: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(name));
}

/**
 * 对模型名打能力标签。
 * @param provider 服务商标识（部分 provider 有命名特例）
 * @param name     模型名（与平台一致）
 * @param extra    可选外部证据（如 Moonshot supports_image_in 等列表接口返回的能力位）
 */
export function classifyModel(_provider: string, name: string, extra: { vision?: boolean } = {}): ModelTag[] {
    const tags: ModelTag[] = [];
    // reranker（排序模型）既不能对话也不能向量化检索，先于 embed 排除，语义归 gen（不出现在任何候选）
    if (/reranker/i.test(name) || /rerank/i.test(name)) {
        tags.push('gen');
        return tags;
    }
    if (matchAny(name, GENERIC_EMBED_PATTERNS)) {
        tags.push('embed');
        return tags; // 嵌入类不会同时是对话/生图
    }
    if (matchAny(name, GENERIC_GEN_PATTERNS)) {
        tags.push('gen');
        return tags; // 生图类不参与对话/嵌入候选
    }
    const vision = extra.vision === true || matchAny(name, GENERIC_VISION_PATTERNS);
    if (vision) tags.push('vision');
    if (!vision) tags.push('text');
    return tags;
}

/** 嵌入命名是否命中白名单（供自动默认兜底判定：明确可分辨才默认） */
export function isKnownEmbedName(name: string): boolean {
    return matchAny(name, GENERIC_EMBED_PATTERNS);
}
