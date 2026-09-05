// 服务商默认 API 基址：api连接省略 base_url 时按 provider 取默认
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
