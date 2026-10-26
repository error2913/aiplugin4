// 媒体生成的**供应商内置请求预设**（逐条迁移自旧依赖插件 aiplugin4-dependencies 的
// tts/MODELS.md 与 tti/MODELS.md —— 旧插件没有代码内置结构，全靠骰主把示例 TOML 粘进配置；
// 这里把那些示例变成"开箱即用"的内置结构，骰主只需在「api连接」填 provider + api_key + base_url）。
//
// 优先级（4.24.0）：**内置预设（本文件） < 「模型规则」的 [body]/[request]/[response]（可选覆盖）**。
//   - [body] 写了就**整体替换**预设结构（结构不同才不会互相污染）；不写就用预设结构；
//   - [request] / [response] 逐键覆盖预设（headers 逐键合并），只想改一项时不必重写整段；
//   - [params] 里声明的默认值/范围/说明优先级高于预设自带的 params。
//
// 地址约定（与旧依赖不同，请注意迁移）：
//   旧配置的 base_url 是**完整接口地址**（如 .../v1/audio/speech）；本插件的「api连接」base_url 是
//   **API 根地址**（如 .../v1），路径由预设的 request.urlSuffix 拼接。为兼容直接粘旧地址的写法，
//   拼路径时会检测 base_url 是否已以该路径结尾，是则原样使用（见 media_template.joinMediaUrl）。
//   request.url 为绝对地址，优先级最高；request.urlSuffix = "" 表示"直接用 base_url 原样"。
//
// provider 用小写匹配；未收录的 provider 落到 '' 的通用预设（OpenAI 兼容形状）。
//
// 已知限制：
//   - 百度 AI 开放平台的 access_token 是**短期令牌**（30 天），而「api连接」只有 api_key 一个字段。
//     两种填法都支持：① api_key 直接填 access_token；② 填 "APIKey:SecretKey"（冒号分隔），
//     插件按 request.auth_token 声明自动换取并按连接缓存复用（见 model/baidu_token.ts）。
//     短文本在线合成无需 api_secret，故已内置；文心一格（生图）仍需双密钥换 token，未内置。
//   - provider "alibaba" 按**兼容模式**（OpenAI 形状）处理；百炼原生异步接口（wanx）请用
//     provider "dashscope"，或在「模型规则」里自行描述结构。
//   - provider "baidu" 走**短文本在线合成**（tsn.baidu.com/text2audio，表单编码 + access_token 进 body + 音色用
//     per 编号）；它没有 /models 列表，必须用 models 钉住一个自定名并在 [types] 声明为 tts。
//     大模型声音复刻（aip.baidubce.com .../voice/clone/tts，JSON + voice_id）结构不同，需在「模型规则」自行描述。
export interface MediaPresetParam {
    type?: string;
    default?: unknown;
    min?: number;
    max?: number;
    enum?: unknown[];
    desc?: string;
}

export interface MediaPreset {
    /** 模型名细分匹配（同一 provider 有多种结构时用，如 dashscope 的 wanx 与 qwen-image） */
    match?: RegExp;
    /** 请求体结构（结构与「模型规则」[body] 同义，含 {占位符}） */
    body: Record<string, unknown>;
    /** 请求地址/请求头/超时等覆盖（url / urlSuffix / method / headers / auth_header_name / content_type / timeout） */
    request?: Record<string, unknown>;
    /** 取数规则（data_path / data_type / task_id_path / poll_url…） */
    response?: Record<string, unknown>;
    /** 该预设自带的可覆写参数默认值/取值说明（低于「模型规则」[params]） */
    params?: Record<string, MediaPresetParam>;
}

type MediaPresetUse = 'tts' | 'image-generation';

/** OpenAI 兼容语音（硅基流动 / 智谱 / 百炼兼容模式 / 大多数网关） */
function openAiCompatTts(opts: { response_format?: string; voice?: string; speed?: boolean; desc?: string } = {}): MediaPreset {
    const body: Record<string, unknown> = {
        model: '{model}',
        input: '{text}',
        voice: '{voice}',
        response_format: opts.response_format ?? 'mp3',
    };
    if (opts.speed) body.speed = '{rate}';
    const params: Record<string, MediaPresetParam> = {};
    if (opts.voice) params.voice = { type: 'string', default: opts.voice, desc: opts.desc ?? 'Voice' };
    return {
        body,
        request: { urlSuffix: '/audio/speech' },
        // OpenAI 兼容 /audio/speech 返回裸音频：整响应读二进制转 base64
        // （fetchData 的 binary 模式会按 content-type 自适应，JSON 响应仍按 data_path 取数）
        response: { data_type: 'base64' },
        params,
    };
}

/** OpenAI 兼容生图（gpt-image / 火山方舟 / 腾讯 TokenHub / 智谱 cogview 等） */
function openAiCompatImage(opts: { response_format?: string; size?: string; data_path?: string } = {}): MediaPreset {
    const body: Record<string, unknown> = {
        model: '{model}',
        prompt: '{prompt}',
        n: 1,
        size: '{size}',
    };
    if (opts.response_format) body.response_format = opts.response_format;
    const params: Record<string, MediaPresetParam> = {};
    if (opts.size) params.size = { type: 'string', default: opts.size, desc: 'Size, e.g. 1024x1024' };
    return {
        body,
        request: { urlSuffix: '/images/generations' },
        response: opts.data_path ? { data_path: opts.data_path } : {},
        params,
    };
}

const GOOGLE_CLOUD_TTS: MediaPreset = {
    body: {
        input: { text: '{text}' },
        voice: { languageCode: 'zh-CN', name: '{voice}' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: '{rate}' },
    },
    request: { auth_header_name: 'x-goog-api-key', url: '{origin}/v1beta1/text:synthesize' },
    response: { data_path: 'audioContent', data_type: 'base64' },
    params: { voice: { type: 'string', default: 'zh-CN-Chirp3-HD-Aoqi', desc: 'Voice (Google voice name)' } },
};

/** 百炼原生（dashscope）：wanx 系列异步提交 + 轮询 */
const DASHSCOPE_WANX: MediaPreset = {
    match: /wanx/i,
    body: {
        model: '{model}',
        input: { prompt: '{prompt}', negative_prompt: '{negative_prompt}' },
        parameters: { size: '{size}', n: 1 },
    },
    request: {
        url: '{origin}/api/v1/services/aigc/text2image/image-synthesis',
        headers: { 'X-DashScope-Async': 'enable' },
        poll_url: 'https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}',
        poll_interval: 10,
        poll_max: 30,
    },
    response: {
        task_id_path: 'output.task_id',
        task_status_path: 'output.task_status',
        data_path: 'output.results.0.url',
        success_values: ['SUCCEEDED', 'SUCCESS'],
        failure_values: ['FAILED'],
    },
    params: { size: { type: 'string', default: '1024*1024', desc: 'Size (DashScope uses * as separator, e.g. 1024*1024)' } },
};

/** 百炼原生（dashscope）：qwen-image 系列同步返回 */
const DASHSCOPE_QWEN_IMAGE: MediaPreset = {
    body: {
        model: '{model}',
        input: { messages: [{ role: 'user', content: [{ text: '{prompt}' }] }] },
        parameters: { prompt_extend: true, negative_prompt: '{negative_prompt}', size: '{size}', n: 1 },
    },
    request: { url: '{origin}/api/v1/services/aigc/multimodal-generation/generation' },
    response: { data_path: 'output.choices.0.message.content.0.image' },
    params: { size: { type: 'string', default: '1024*1024', desc: 'Size (DashScope uses * as separator, e.g. 1024*1024)' } },
};

/**
 * 百炼原生 **Qwen-Audio-TTS**（`qwen-audio-3.x-tts-*`）。
 *
 * ⚠ 端点与 Qwen3-TTS **不同** —— 它和 CosyVoice **共用**
 * `/api/v1/services/audio/tts/SpeechSynthesizer`。
 *
 * 这一条是**用真 key 实测**纠正过来的：先前把它归到 Qwen3-TTS 的
 * `multimodal-generation/generation`，该端点对它一律回
 * `400 InvalidParameter: url error, please check url！`（百炼的"模型与端点不匹配"）。
 * 换到 SpeechSynthesizer 立刻 **200**，返回 `output.audio.url`。
 *
 * 依据：官方「非实时语音合成Qwen-Audio-TTS HTTP API参考」——
 *   POST {WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
 *   body: { model, input: { text, voice, format, sample_rate } }
 *   format 默认 mp3（mp3/pcm/wav/opus）；sample_rate 默认 22050
 *   （8000/12000/16000/22050/24000/44100/48000）
 *
 * 实测：`format` / `sample_rate` 都可省（官方有默认值），voice 必填。
 */
const DASHSCOPE_QWEN_AUDIO_TTS: MediaPreset = {
    match: /qwen-audio[\w.-]*tts/i,
    body: {
        model: '{model}',
        input: { text: '{text}', voice: '{voice}', format: '{format}', sample_rate: '{sample_rate}' },
    },
    request: { url: '{origin}/api/v1/services/audio/tts/SpeechSynthesizer' },
    response: { data_path: 'output.audio.url', data_type: 'url' },
    params: {
        // ⚠ 音色**按代际区分**，不通用：`longanhuan_v3.1` 属 3.1 族、`longanhuan_v3.6` 属 3.0 族。
        // 用错代际不会报「音色不存在」，而是 `[cosyvoice:]Engine error [411]`（实测），很难查。
        // 默认取 3.1 族（当前主力）；用 3.0 模型时请自行改成对应音色。
        voice: { type: 'string', default: 'longanhuan_v3.1', desc: 'Voice (must match the model generation; see the official voice list)' },
        format: { type: 'string', enum: ['mp3', 'wav', 'pcm', 'opus'], default: 'mp3', desc: 'Audio encoding format' },
        sample_rate: { type: 'number', default: 24000, desc: 'Sample rate (Hz)' },
    },
};

/**
 * 百炼原生 **Qwen3-TTS**（`qwen3-tts-flash` 等，老一代）。
 *
 * 走 `multimodal-generation/generation`，**不是** `/audio/speech` —— 后者是
 * **cosyvoice** 的 OpenAI 兼容路径。Qwen 系 TTS 打到 `/audio/speech` 会 404
 * （响应体还是空的，只能看到一个状态码，非常难查；实测踩过）。
 *
 * 依据：官方「非实时语音合成（Qwen3-TTS）API 参考」——
 *   POST {host}/api/v1/services/aigc/multimodal-generation/generation
 *   body: { model, input: { text, voice, language_type } }
 *   非流式返回 output.audio.url；流式的中间 chunk 用 output.audio.data（base64）。
 */
const DASHSCOPE_QWEN3_TTS: MediaPreset = {
    match: /qwen3[\w.-]*tts/i,
    body: {
        model: '{model}',
        input: { text: '{text}', voice: '{voice}', language_type: '{language_type}' },
    },
    request: { url: '{origin}/api/v1/services/aigc/multimodal-generation/generation' },
    response: { data_path: 'output.audio.url', data_type: 'url' },
    params: {
        voice: { type: 'string', default: 'Cherry', desc: 'Voice, e.g. Cherry / Serena' },
        language_type: { type: 'string', default: 'Chinese', desc: 'Language; Auto lets the model decide' },
    },
};

/**
 * 百炼原生 **CosyVoice**。
 *
 * 端点与前两个都不同：`/api/v1/services/audio/tts/SpeechSynthesizer`
 * （**不是** `/audio/speech` —— 那是 OpenAI 兼容路径，只适用于兼容模式基址）。
 *
 * 依据：官方「非实时语音合成CosyVoice HTTP API参考」——
 *   body: { model, input: { text, voice, format, sample_rate } }
 *   非流式返回 output.audio.url。
 *
 * 这条是**补漏**：此前 dashscope 的 TTS 项直接从 alibaba 抄了 `openAiCompatTts`
 * （`/audio/speech`），挂在原生基址上会拼出 `https://host/audio/speech` —— 缺 `/api/v1`，必 404。
 */
const DASHSCOPE_COSYVOICE: MediaPreset = {
    match: /cosyvoice/i,
    body: {
        model: '{model}',
        input: { text: '{text}', voice: '{voice}', format: '{format}', sample_rate: 22050 },
    },
    request: { url: '{origin}/api/v1/services/audio/tts/SpeechSynthesizer' },
    response: { data_path: 'output.audio.url', data_type: 'url' },
    params: {
        voice: { type: 'string', default: 'longanyang', desc: 'Voice; see the official voice list' },
        format: { enum: ['mp3', 'wav', 'pcm', 'opus'], default: 'mp3', desc: 'Audio format' },
    },
};

export const MEDIA_PRESETS: Record<MediaPresetUse, Record<string, MediaPreset[]>> = {
    tts: {
        // 通用（OpenAI 兼容，默认拼 base_url + /audio/speech）
        '': [openAiCompatTts({ speed: true })],
        openai: [openAiCompatTts({ speed: true })],
        // 硅基流动：MOSS-TTSD / CosyVoice2 / fish-speech 等，示例里带 speed
        siliconflow: [openAiCompatTts({ speed: true })],
        // 智谱 glm-tts：返回 wav，示例无 speed
        zhipu: [openAiCompatTts({ response_format: 'wav', voice: 'tongtong' })],
        // 百炼兼容模式（cosyvoice 系列）
        // 百炼原生：三个 TTS 系各有**不同**端点，全部按模型名细分。
        // 顺序重要 —— resolveMediaPreset 取**第一个 match 命中**的。
        //   1. Qwen-TTS        /api/v1/services/aigc/multimodal-generation/generation
        //   2. CosyVoice       /api/v1/services/audio/tts/SpeechSynthesizer
        // 这里**不放** openAiCompatTts：那是兼容模式（/audio/speech）的形态，
        // 挂在原生基址上会拼出 https://host/audio/speech —— 缺 /api/v1，必 404。
        // 认不出的模型会回退到全局通用项（table[''][0]），而不是硬凑一个错的。
        dashscope: [DASHSCOPE_QWEN_AUDIO_TTS, DASHSCOPE_QWEN3_TTS, DASHSCOPE_COSYVOICE],
        // 百炼兼容模式基址（/compatible-mode/v1）。
        //
        // 关键：**TTS 也挂在这里**，而且用的是**原生端点**（`{origin}` 表达）。
        // 为什么：官方明确「Qwen-Audio 不支持 OpenAI 兼容协议」，且兼容模式里
        // 并没有 /audio/speech 这个路径（实测 404 而非 400 —— 路径不存在）。
        // 所以用户只填一个兼容模式 baseURL 时，TTS 必须被路由到主机根下的原生端点。
        // `{origin}` 让这些预设与基址的路径前缀无关 —— 用户填兼容模式基址、host 根、
        // 甚至完整端点都能正确工作，**不必为此另开一条连接**。
        //
        // 顺序重要：resolveMediaPreset 取第一个 match 命中的。
        alibaba: [
            DASHSCOPE_QWEN_AUDIO_TTS,
            DASHSCOPE_QWEN3_TTS,
            DASHSCOPE_COSYVOICE,
            openAiCompatTts({ voice: 'longxiaochun' }),
        ],
        // Gemini 的 OpenAI 兼容入口
        google: [openAiCompatTts({})],
        // Google Cloud 原生 text:synthesize
        'google-cloud': [GOOGLE_CLOUD_TTS],
        // MiniMax t2a_v2：hex 输出（本期保留 hex 支持的原因）
        minimax: [{
            body: {
                model: '{model}',
                text: '{text}',
                stream: false,
                output_format: 'hex',
                voice_setting: { voice_id: '{voice}', speed: '{rate}', vol: '{volume}', pitch: '{pitch}' },
                audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
            },
            request: { urlSuffix: '/t2a_v2' },
            response: { data_path: 'data.audio', data_type: 'hex' },
            params: {
                voice: { type: 'string', default: 'female-cq', desc: 'Voice (MiniMax voice_id)' },
                volume: { type: 'number', desc: 'Volume' },
                pitch: { type: 'number', desc: 'Pitch' },
            },
        }],
        // Fish Audio v3
        fishaudio: [{
            body: { text: '{text}', voiceId: '{voice}', modelId: '{model}', format: 'mp3' },
            request: { url: '{origin}/api/open/v3/speech/tts' },
            response: { data_type: 'base64' },
            params: { voice: { type: 'string', default: '53a27b24-38c9-47fd-9dc6-dd8fcd55f0a9', desc: 'Voice ID' } },
        }],
        // 百度短文本在线合成（语音技术，非 OpenAI 兼容）：表单编码 + access_token 进 body。
        // 鉴权用 access_token（aip.baidubce.com/oauth/2.0/token 由 API Key + Secret Key 换取，30 天有效），
        // 所以这里的 api_key 填 **access_token**，或填 "APIKey:SecretKey" 由请求头注入自动换取（见 baidu_token.ts）。
        // 模型名仅作连接/用途候选的占位（百度没有 /models 列表，必须用 models 钉住 + [types] 声明 tts）。
        // urlSuffix 用 ""：base_url 原样即接口地址（https://tsn.baidu.com/text2audio）。
        baidu: [{
            body: {
                tex: '{text}',
                tok: '{api_key}',
                cuid: 'aiplugin4',
                ctp: '1',
                lan: 'zh',
                per: '{voice}',
                aue: 3,
                spd: '{rate}',
                pit: '{pitch}',
                vol: '{volume}',
            },
            // auth_token = "baidu-token"：请求前用 api_key 里的双密钥（APIKey:SecretKey）换 access_token；
            // api_key 直接填 access_token 时该逻辑自动跳过（见 model/baidu_token.ts）。
            request: { urlSuffix: '', content_type: 'application/x-www-form-urlencoded', timeout: 60, auth_token: 'baidu-token' },
            // 成功：Content-Type 以 audio 开头、整响应即音频（binary + base64）；
            // 失败：HTTP 200 + application/json，业务错误在 err_msg（err_no 一律 502，无区分度）
            response: { data_type: 'base64', error_message_path: 'err_msg' },
            params: {
                voice: { type: 'string', default: '5003', desc: 'Speaker per number (5003=度逍遥精品, 0=度小美, 4189=度涵竹大模型音库; see the Baidu voice list doc for the full list)' },
                rate: { type: 'string', default: '5', desc: 'Speed spd, 0-15, 5 is medium speed' },
                pitch: { type: 'string', default: '5', desc: 'Pitch pit, 0-15, 5 is medium pitch' },
                volume: { type: 'string', default: '5', desc: 'Volume vol, basic voice library 0-9, other libraries 0-15, 5 is medium volume' },
            },
        }],
        // ElevenLabs：音色 ID 直接进地址，鉴权头为 xi-api-key
        elevenlabs: [{
            body: { text: '{text}', model_id: '{model}', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
            request: { auth_header_name: 'xi-api-key', url: '{origin}/v1/text-to-speech/{voice}' },
            response: { data_type: 'base64' },
            params: { voice: { type: 'string', default: '21m00Tcm4TlvDq8ikWAM', desc: 'Voice ID (ElevenLabs voice_id)' } },
        }],
    },
    'image-generation': {
        // 通用（OpenAI 兼容）
        '': [openAiCompatImage()],
        openai: [
            // gpt-image 系列：不支持 response_format，图片恒为 base64
            { ...openAiCompatImage({ data_path: 'data.0.b64_json' }), match: /gpt-image/i },
            openAiCompatImage({ response_format: 'b64_json', data_path: 'data.0.b64_json' }),
        ],
        // 火山方舟 / 腾讯 TokenHub / 智谱 cogview：兼容模式返回 url
        volcengine: [openAiCompatImage({ response_format: 'url', data_path: 'data.0.url' })],
        'tencent-tokenhub': [openAiCompatImage({ size: '1024:1024', data_path: 'data.0.url' })],
        zhipu: [{
            ...openAiCompatImage({ data_path: 'data.0.url' }),
            body: { model: '{model}', prompt: '{prompt}', size: '{size}', quality: '{quality}' },
            params: {
                size: { type: 'string', default: '1024x1024', desc: 'Size, e.g. 1024x1024' },
                quality: { enum: ['hd', 'standard'], desc: 'Quality' },
            },
        }],
        // 百炼（**用户只该看到这一个入口**）。
        //
        // 生图两条路都用，用户不必选"哪种模式"：
        //   · wanx 系列 → 原生异步端点（兼容模式对 wanx 的支持不保证）
        //   · 其余（qwen-image 等）→ 兼容模式 /images/generations（实测可用）
        // 顺序：带 match 的在前，通用兼容项兜底。
        alibaba: [DASHSCOPE_WANX, openAiCompatImage()],
        // 百炼原生（全原生）—— 保留给"只暴露原生接口"的部署（逃生舱）。
        // 界面上不再作为独立模板出现：正常用 alibaba 一条连接即可（TTS 已走 {origin} 原生端点）。
        dashscope: [DASHSCOPE_WANX, DASHSCOPE_QWEN_IMAGE],
        // 硅基流动（FLUX 等）
        siliconflow: [{
            body: { model: '{model}', prompt: '{prompt}', image_size: '{size}', batch_size: 1, negative_prompt: '{negative_prompt}' },
            request: { urlSuffix: '/images/generations' },
            response: { data_path: 'images.0.url' },
            params: { size: { type: 'string', default: '1024x1024', desc: 'Image size, e.g. 1024x1024' } },
        }],
        // Google Gemini 原生 generateContent
        gemini: [{
            body: {
                contents: [{ parts: [{ text: '{prompt}' }] }],
                generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
            },
            request: {
                auth_header_name: 'x-goog-api-key',
                url: '{origin}/v1beta/models/{model}:generateContent',
                timeout: 120,
            },
            response: { data_path: 'candidates.0.content.parts.0.inlineData.data', data_type: 'base64' },
        }],
        // Stability（multipart/form-data）
        stability: [
            {
                match: /ultra/i,
                body: { prompt: '{prompt}', aspect_ratio: '1:1', negative_prompt: '{negative_prompt}', output_format: 'png' },
                request: {
                    url: '{origin}/v2beta/stable-image/generate/ultra',
                    content_type: 'multipart/form-data',
                    headers: { accept: 'application/json' },
                    timeout: 180,
                },
                response: { data_path: 'image', data_type: 'base64' },
            },
            {
                body: { prompt: '{prompt}', aspect_ratio: '1:1', negative_prompt: '{negative_prompt}', output_format: 'png' },
                request: {
                    url: '{origin}/v2beta/stable-image/generate/core',
                    content_type: 'multipart/form-data',
                    headers: { accept: 'application/json' },
                    timeout: 120,
                },
                response: { data_path: 'image', data_type: 'base64' },
            },
        ],
        // 本地 / 自建（Stable Diffusion WebUI）：base_url 直接填完整接口地址
        custom: [{
            body: { prompt: '{prompt}', negative_prompt: '{negative_prompt}', steps: 25, width: 768, height: 768, batch_size: 1 },
            request: { urlSuffix: '' },
            response: { data_path: 'images.0' },
        }],
    },
};

/**
 * 取该 provider + 用途的内置预设：先按模型名细分匹配，再取该 provider 的默认，最后落通用预设。
 * 未收录的 provider 一律用 '' 的通用（OpenAI 兼容）预设。
 */
export function resolveMediaPreset(provider: string, use: MediaPresetUse, modelName = ''): MediaPreset {
    const table = MEDIA_PRESETS[use];
    const key = String(provider || '').trim().toLowerCase();
    const entries = table[key] ?? table[''];
    const matched = entries.find(e => e.match && e.match.test(String(modelName || '')));
    if (matched) return matched;
    const generic = entries.find(e => !e.match);
    return generic ?? table[''][0];
}
