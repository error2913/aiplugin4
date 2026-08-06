// 后端服务配置：流式/图片转base64/搜索/用量图/渲染等 URL
import { ext } from "../config";
export default class BackendConfig {
    static register() {
        seal.ext.registerStringConfig(ext, "流式输出", "http://localhost:3010", '自行搭建或使用他人提供的后端', "后端");
        seal.ext.registerStringConfig(ext, "图片转base64", "http://127.0.0.1:46678", '可自行搭建', "后端");
        seal.ext.registerStringConfig(ext, "联网搜索", "https://searxng.fishwhite.top", '可自行搭建', "后端");
        seal.ext.registerStringConfig(ext, "网页读取", "http://127.0.0.1:46799", '可自行搭建', "后端");
        seal.ext.registerStringConfig(ext, "用量图表", "http://127.0.0.1:3009", '可自行搭建', "后端");
        seal.ext.registerStringConfig(ext, "md和html图片渲染", "http://127.0.0.1:37632", '可自行搭建', "后端");
        seal.ext.registerStringConfig(ext, "论坛地址", "https://aiplugin-forum.fishwhite.top", 'aiplugin4专用论坛地址', "后端");
        seal.ext.registerStringConfig(ext, "论坛API Token", "", '论坛注册后获取的api_token，用于发帖等写操作的鉴权', "后端");
        seal.ext.registerStringConfig(ext, "论坛签名密钥", "", '论坛注册后获取的secret_key，用于请求签名', "后端");
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
