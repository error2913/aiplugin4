export const PROVIDER_MAP: { [provider: string]: string } = {
    "deepseek": "https://api.deepseek.com/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    "alibaba": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "openai": "https://api.openai.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
    "anthropic": "https://api.anthropic.com/v1",
    "moonshot": "https://api.moonshot.cn/v1",
    "xai": "https://api.x.ai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "siliconflow": "https://api.siliconflow.cn/v1"
}

export const CHAT_MODEL_MAP = {
    "deepseek": ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash"],
    "openai": ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "o4-mini"],
    "google": ["gemini-3-pro-preview-low", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    "zhipu": ["glm-4", "glm-4-flash", "glm-4.5", "glm-4.7-flash"],
    "alibaba": ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max", "qwen3.5-plus", "qwen3.5-flash"],
    "anthropic": ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
    "moonshot": ["kimi-k2-0905-preview", "moonshot-v1-32k"],
    "xai": ["grok-3", "grok-4"],
    "mistral": ["mistral-large-latest", "mistral-small-latest"],
    "siliconflow": ["deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3-235B-A22B-Instruct"]
};
export const CHAT_MODEL_TO_PROVIDER = Object.entries(CHAT_MODEL_MAP).reduce((acc, [provider, models]) => {
    models.forEach(model => acc[model] = provider);
    return acc;
}, {} as { [model: string]: string });
export const MULTIMODAL_MODEL_MAP = {
    "zhipu": ["glm-4v", "glm-4v-plus-0111", "glm-4v-flash", "glm-4.6v"],
    "alibaba": ["qwen-vl-max", "qwen-vl-plus", "qwen2.5-vl-72b-instruct"],
    "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    "google": ["gemini-2.5-pro", "gemini-2.5-flash"],
    "siliconflow": ["Qwen/Qwen2.5-VL-72B-Instruct", "THUDM/GLM-4.6V-9B"]
};
export const MULTIMODAL_MODEL_TO_PROVIDER = Object.entries(MULTIMODAL_MODEL_MAP).reduce((acc, [provider, models]) => {
    models.forEach(model => acc[model] = provider);
    return acc;
}, {} as { [model: string]: string });
export const EMBEDDING_MODEL_MAP = {
    "alibaba": ["text-embedding-v4", "text-embedding-v3", "text-embedding-v2"],
    "openai": ["text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"],
    "zhipu": ["embedding-3"],
    "siliconflow": ["BAAI/bge-m3", "BAAI/bge-large-zh-v1.5", "Qwen/Qwen3-Embedding-0.6B"]
};
export const EMBEDDING_MODEL_TO_PROVIDER = Object.entries(EMBEDDING_MODEL_MAP).reduce((acc, [provider, models]) => {
    models.forEach(model => acc[model] = provider);
    return acc;
}, {} as { [model: string]: string });

