// 后端服务配置：流式/图片转base64/搜索/用量图/论坛等 URL
// 网页读取（web-read）与 md/html 渲染（md-html-render）为 MCP 服务，已移入「工具 → MCP服务器配置」
import { ext } from "../config";
export default class BackendConfig {
    static register() {
        seal.ext.registerStringConfig(ext, "流式输出", "http://localhost:3010", '流式输出后端地址（aiplugin4-backends 的 stream-output）。\n模型 body.stream=true 且非 anthropic 提供商时走流式，经该地址对接后端', "后端");
        seal.ext.registerStringConfig(ext, "图片转base64", "http://127.0.0.1:46678", '图片转 base64 后端地址（aiplugin4-backends 的 image-url-to-base64），用于把图片 URL 转成 base64 供模型读取', "后端");
        seal.ext.registerStringConfig(ext, "联网搜索", "https://searxng.fishwhite.top", '联网搜索后端地址（SearXNG 兼容实例），供 web_search 工具使用', "后端");
        seal.ext.registerStringConfig(ext, "用量图表", "http://127.0.0.1:3009", '用量统计图表后端地址（aiplugin4-backends 的 usage-chart），供 .ai token 用量图表使用', "后端");
        seal.ext.registerStringConfig(ext, "论坛地址", "https://aiplugin-forum.fishwhite.top", 'aiplugin4 专用论坛地址，用于论坛工具；一般保持默认', "后端");
        seal.ext.registerStringConfig(ext, "论坛API Token", "", '论坛注册后获取的 api_token，用于发帖等写操作的鉴权；不填则只能使用只读功能', "后端");
        seal.ext.registerStringConfig(ext, "论坛签名密钥", "", '论坛注册后获取的 secret_key，用于请求签名；与「论坛API Token」配套填写', "后端");
        seal.ext.registerStringConfig(ext, "核心指令中转WS地址", "ws://127.0.0.1:46880/control", 'aiplugin4-backends/ob11-core-bridge 的控制 WebSocket 地址；留空则 run_ext_command/run_core_command 不可用', "后端");
        seal.ext.registerStringConfig(ext, "核心指令中转Token", "", '与中间件 AIPLUGIN4_BRIDGE_TOKEN 一致；不需要鉴权时留空', "后端");
    }

    static get() {
        return {
            STREAM: seal.ext.getStringConfig(ext, "流式输出"),
            IMAGE_TO_BASE64: seal.ext.getStringConfig(ext, "图片转base64"),
            WEB_SEARCH: seal.ext.getStringConfig(ext, "联网搜索"),
            USAGE_CHART: seal.ext.getStringConfig(ext, "用量图表"),
            FORUM_URL: seal.ext.getStringConfig(ext, "论坛地址"),
            FORUM_API_TOKEN: seal.ext.getStringConfig(ext, "论坛API Token"),
            FORUM_SECRET_KEY: seal.ext.getStringConfig(ext, "论坛签名密钥"),
            CORE_BRIDGE_WS: seal.ext.getStringConfig(ext, "核心指令中转WS地址"),
            CORE_BRIDGE_TOKEN: seal.ext.getStringConfig(ext, "核心指令中转Token")
        }
    }
}
