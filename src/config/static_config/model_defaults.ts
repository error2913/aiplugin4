export const DEFAULT_CHAT_MODEL_BODY = {
    "max_tokens": 8192,
    "stop": null,
    "stream": false
}
export const DEFAULT_MULTIMODAL_MODEL_BODY = {
    "max_tokens": 2048,
    "stop": null,
    "stream": false
}
export const DEFAULT_EMBEDDING_MODEL_BODY = {
    "encoding_format": "float",
    "dimensions": 1024
}

// ---- 媒体生成（tts / image-generation）参数元信息 ----
// 请求**结构**不再由代码兜底，而是走「内置预设」（media_presets.ts：按 provider/模型名给结构）；
// 这里只保留通用占位符的默认值与取值区间（{voice} / {rate} / {size}），
// 并且仅在模板（内置预设或规则 [body]）里真的出现对应 {占位符} 时才会被采纳。
export const DEFAULT_TTS_PARAMS = {
    "voice": { "type": "string", "default": "alloy", "desc": "Voice" },
    "rate": { "type": "number", "default": 1.0, "min": 0.25, "max": 4.0, "desc": "Speed" }
}

export const DEFAULT_IMAGE_PARAMS = {
    "size": { "type": "string", "default": "1024x1024", "desc": "Size, e.g. 1024x1024" }
}
