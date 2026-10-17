// 模型能力分类：给连接拉取/钉住的模型名打能力标签，供「候选/默认」判定使用。
// 标签语义（供 model/model.ts 使用）：
//   embed —— 文本嵌入模型（只进 text-embedding 候选，绝不进对话候选）
//   gen   —— 图像生成类（只进 image-generation 候选，不进对话/嵌入候选）
//   tts   —— 语音合成类（只进 tts 候选，不进对话/嵌入/生图候选）
//   vision—— 支持图像输入（可进对话与 image-understanding 候选）
//   text  —— 普通文本（对话候选）
// 原则：只有能明确分辨的类别才会自动成为默认（embed/生图/语音白名单、vision 证据或白名单）；
// 未知命名一律归 text 候选，绝不擅自当作 vision/embed/gen/tts 默认。
// 判定优先级：手动声明（「api连接」[types]） > 命名终值（rerank/生图/语音/嵌入白名单） > 接口能力位（仅正向证据） > 命名能力位 > 兜底 text；
// 手动声明即最终答案，与自动判定冲突时不记日志。当前每条分支恰好产出 1 个标签（数组形态沿用历史结构）。
// 纯模块：不依赖 seal / Config，便于单元测试。

export type ModelTag = 'text' | 'vision' | 'embed' | 'gen' | 'tts';

/**
 * 可手动声明的类型。
 * gen/tts 同样开放声明：非 OpenAI 兼容的语音/生图服务（Google Cloud TTS、百度、自建 SD 等）
 * 没有 /models 列表，其「模型名」通常是钉住的自定名，命名白名单识别不到，只能靠 [types] 声明。
 * reranker 仍由命名白名单判定为 gen（属终值语义，不开放声明）。
 */
export type DeclarableModelTag = 'text' | 'vision' | 'embed' | 'gen' | 'tts';

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
    // 词边界而非锚定开头：聚合平台的厂商前缀名（black-forest-labs/FLUX.1-schnell）
    // 在硅基流动等平台上是主流写法，锚定写法识别不到。
    /(^|[^a-z0-9])flux/i,
    /stable-diffusion/i,
    /(^|[^a-z0-9])sd3/i,
    /kolors/i,
    /hunyuan-image/i,
    /(^|[^a-z0-9])seedream/i,
    /(^|[^a-z0-9])midjourney/i,
    /(^|[^a-z0-9])imagen/i,
    /(^|[^a-z0-9])veo/i,
    // 阿里百炼 qwen-image 系列（qwen-image-3.0-pro / qwen-image-3.0 / qwen-image-2.1-pro）。
    // 漏了它的话，官方生图模型会被当成对话模型，用户每次都得手动改类型。
    /(^|[^a-z0-9])qwen-image/i,
];

// 语音合成类命名白名单：与生图/嵌入同为「终值」语义（不会同时是对话模型）。
// 覆盖常见 TTS 服务与开源模型：OpenAI tts-1/gpt-4o-mini-tts、阿里 cosyvoice、
// 硅基流动 fish-speech/CosyVoice2、字节/微软 speech 系列、开源 chattts/sovits 等。
const GENERIC_TTS_PATTERNS: RegExp[] = [
    /(^|[^a-z0-9])tts([^a-z0-9]|$)/i,
    /cosyvoice/i,
    /fish-speech/i,
    /text-to-speech/i,
    /speech-synthesis/i,
    /(^|[^a-z0-9])speech-[0-9]/i,
    /(^|[^a-z0-9])sovits/i,
    /(^|[^a-z0-9])gpt-sovits/i,
    /chattts/i,
    /(^|[^a-z0-9])sambert/i,
    /(^|[^a-z0-9])azure.*speech/i,
    /(^|[^a-z0-9])edge-tts/i,
    /(^|[^a-z0-9])melo-?tts/i,
    /(^|[^a-z0-9])bark([^a-z0-9]|$)/i,
];

// 视觉模型：**不再靠命名猜测**（v5 起）。
//
// 原 GENERIC_VISION_PATTERNS（pixtral / glm-4v / qwen-vl / *vision / gpt-4o / gpt-5 / kimi-k2 …）
// 已删除：这批正则最容易过期（新模型名永远追不上），且猜错的代价与收益不对等 ——
// 猜错只是"少一个识图候选"，却会让用户误以为模型已具备视觉能力。
//
// 现在一律归 text，由用户在配置里显式声明 `kind: "vision"`（生成器会自动预填）。
// 仍**保留**接口自报能力位（extra.vision）这条正向证据。
//
// 注意：保留这个空数组与常量名，避免调用点与文档引用失效；
// 同时保留下方 matchAny 的调用形态，便于将来需要时恢复。

function matchAny(name: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(name));
}

/**
 * 对模型名打能力标签。
 *
 * 原则（v5）：只对**终值语义**下判断 —— 即"猜错后果严重"的四类
 * （嵌入 / 生图 / 语音 / rerank：误判成对话模型会直接报错或浪费钱）。
 * 视觉不再猜，一律 text，由配置显式声明。
 *
 * @param _provider 服务商标识（保留参数以兼容调用点；当前无按厂商的命名特例）
 * @param name      模型名（与平台一致）
 * @param extra     外部证据：manual（手动声明，绝对优先）/ vision、embed（接口自报能力位）
 */
export function classifyModel(_provider: string, name: string, extra: ClassifyExtra = {}): ModelTag[] {
    // 1) 手动声明：绝对优先（含用显式 text 覆盖命名猜测）
    if (extra.manual) return [extra.manual];
    // 2) 命名终值：reranker（排序模型）既不能对话也不能向量化检索，语义归 gen（不出现在任何候选）；
    //    生图/语音/嵌入白名单同理属「终值/排除」语义，优先级高于网关自报元数据（元数据质量不可控）。
    //    顺序不可调换：语音必须在"能力位"之前判定 —— 如 gpt-4o-mini-tts 含 gpt-4o，
    //    若先按命名能力位判视觉会被误判（v5 已删视觉正则，但顺序约束保留以防回归）。
    if (/reranker/i.test(name) || /rerank/i.test(name)) return ['gen'];
    if (matchAny(name, GENERIC_EMBED_PATTERNS)) return ['embed']; // 嵌入类不会同时是对话/生图/语音
    if (matchAny(name, GENERIC_GEN_PATTERNS)) return ['gen'];     // 生图类不参与对话/嵌入/语音候选
    if (matchAny(name, GENERIC_TTS_PATTERNS)) return ['tts'];     // 语音类不参与对话/嵌入/生图候选
    // 3) 接口能力位：只取正向证据（不产出 text，避免把明显多模态的模型降级为纯文本）
    if (extra.embed === true) return ['embed'];
    if (extra.vision === true) return ['vision'];
    // 4) 兜底：一律 text。视觉不再靠命名猜测（v5），需在配置里显式声明 kind: "vision"
    return ['text'];
}

/** 嵌入命名是否命中白名单（供自动默认兜底判定：明确可分辨才默认） */
export function isKnownEmbedName(name: string): boolean {
    return matchAny(name, GENERIC_EMBED_PATTERNS);
}
