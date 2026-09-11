// 模型能力分类：给连接拉取/钉住的模型名打能力标签，供「候选/默认」判定使用。
// 标签语义（供 model/model.ts 使用）：
//   embed —— 文本嵌入模型（只进 text-embedding 候选，绝不进对话候选）
//   gen   —— 图像生成类（本插件不消费，全部排除在候选外）
//   vision—— 支持图像输入（可进对话与 image-understanding 候选）
//   text  —— 普通文本（对话候选）
// 原则：只有能明确分辨的类别才会自动成为默认（embed 白名单/vision 证据或白名单）；
// 未知命名一律归 text 候选，绝不擅自当作 vision/embed 默认。
// 判定优先级：手动声明（「api连接」[types]） > 命名终值（rerank/生图/嵌入白名单） > 接口能力位（仅正向证据） > 命名能力位 > 兜底 text；
// 手动声明即最终答案，与自动判定冲突时不记日志。当前每条分支恰好产出 1 个标签（数组形态沿用历史结构）。
// 纯模块：不依赖 seal / Config，便于单元测试。

export type ModelTag = 'text' | 'vision' | 'embed' | 'gen';

/** 可手动声明的类型（不含内部排除值 gen：生图/reranker 仅由命名白名单判定） */
export type DeclarableModelTag = 'text' | 'vision' | 'embed';

/** 分类外部证据：manual=手动声明（绝对优先）；vision/embed=接口自报能力位（只取正向证据） */
export interface ClassifyExtra {
    manual?: DeclarableModelTag;
    vision?: boolean;
    embed?: boolean;
}

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
 * @param extra    外部证据：manual（手动声明，绝对优先）/ vision、embed（接口自报能力位）
 */
export function classifyModel(_provider: string, name: string, extra: ClassifyExtra = {}): ModelTag[] {
    // 1) 手动声明：绝对优先（含用显式 text 覆盖命名猜测）
    if (extra.manual) return [extra.manual];
    // 2) 命名终值：reranker（排序模型）既不能对话也不能向量化检索，语义归 gen（不出现在任何候选）；
    //    生图/嵌入白名单同理属「终值/排除」语义，优先级高于网关自报元数据（元数据质量不可控）
    if (/reranker/i.test(name) || /rerank/i.test(name)) return ['gen'];
    if (matchAny(name, GENERIC_EMBED_PATTERNS)) return ['embed']; // 嵌入类不会同时是对话/生图
    if (matchAny(name, GENERIC_GEN_PATTERNS)) return ['gen'];     // 生图类不参与对话/嵌入候选
    // 3) 接口能力位：只取正向证据（不产出 text，避免把明显多模态的模型降级为纯文本）
    if (extra.embed === true) return ['embed'];
    if (extra.vision === true) return ['vision'];
    // 4) 命名能力位 + 兜底
    return matchAny(name, GENERIC_VISION_PATTERNS) ? ['vision'] : ['text'];
}

/** 嵌入命名是否命中白名单（供自动默认兜底判定：明确可分辨才默认） */
export function isKnownEmbedName(name: string): boolean {
    return matchAny(name, GENERIC_EMBED_PATTERNS);
}
