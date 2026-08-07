// 后端服务配置：流式/图片转base64/搜索/用量图/渲染等 URL
import { ext } from "../config";
export default class BackendConfig {
    static register() {
        seal.ext.registerStringConfig(ext, "流式输出", "http://localhost:3010", '流式输出后端地址（对应 aiplugin4-backends 的 stream-output），需配合 body.stream=true 的模型；留空则使用非流式', "后端");
        seal.ext.registerStringConfig(ext, "图片转base64", "http://127.0.0.1:46678", '图片转 base64 后端地址（aiplugin4-backends 的 image-url-to-base64），用于把图片 URL 转成 base64 供模型读取', "后端");
        seal.ext.registerStringConfig(ext, "联网搜索", "https://searxng.fishwhite.top", '联网搜索后端地址（SearXNG 兼容实例），供 web_search 工具使用', "后端");
        seal.ext.registerStringConfig(ext, "网页读取", "http://127.0.0.1:46799", '网页读取后端地址（aiplugin4-backends 的 web-read），供读取网页内容工具使用', "后端");
        seal.ext.registerStringConfig(ext, "用量图表", "http://127.0.0.1:3009", '用量统计图表后端地址（aiplugin4-backends 的 usage-chart），供 .ai token 用量图表使用', "后端");
        seal.ext.registerStringConfig(ext, "md和html图片渲染", "http://127.0.0.1:37632", 'Markdown/HTML 渲染为图片的后端地址（aiplugin4-backends 的 md-html-render）', "后端");
        seal.ext.registerStringConfig(ext, "论坛地址", "https://aiplugin-forum.fishwhite.top", 'aiplugin4 专用论坛地址，用于论坛工具；一般保持默认', "后端");
        seal.ext.registerStringConfig(ext, "论坛API Token", "", '论坛注册后获取的 api_token，用于发帖等写操作的鉴权；不填则只能使用只读功能', "后端");
        seal.ext.registerStringConfig(ext, "论坛签名密钥", "", '论坛注册后获取的 secret_key，用于请求签名；与「论坛API Token」配套填写', "后端");
    }

    static get() {
        return {
            STREAM: seal.ext.getStringConfig(ext, "流式输出"),
            IMAGE_TO_BASE64: seal.ext.getStringConfig(ext, "图片转base64"),
            WEB_SEARCH: seal.ext.getStringConfig(ext, "联网搜索"),
            WEB_READ: seal.ext.getStringConfig(ext, "网页读取"),
            USAGE_CHART: seal.ext.getStringConfig(ext, "用量图表"),
            RENDER: seal.ext.getStringConfig(ext, "md和html图片渲染"),
            FORUM_URL: seal.ext.getStringConfig(ext, "论坛地址"),
            FORUM_API_TOKEN: seal.ext.getStringConfig(ext, "论坛API Token"),
            FORUM_SECRET_KEY: seal.ext.getStringConfig(ext, "论坛签名密钥")
        }
    }
}
