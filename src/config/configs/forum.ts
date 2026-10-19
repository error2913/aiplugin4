// 论坛配置：论坛工具使用的地址与鉴权信息（与后端项目无关，独立页签）。
import { ext } from "../config";

export default class ForumConfig {
    static register() {
        seal.ext.registerStringConfig(ext, "论坛地址", "https://aiplugin-forum.fishwhite.top", 'aiplugin4 专用论坛地址，用于论坛工具；一般保持默认', "论坛");
        seal.ext.registerStringConfig(ext, "论坛API Token", "", '论坛注册后获取的 api_token，用于发帖等写操作的鉴权；不填则只能使用只读功能', "论坛");
        seal.ext.registerStringConfig(ext, "论坛签名密钥", "", '论坛注册后获取的 secret_key，用于请求签名；与「论坛API Token」配套填写', "论坛");
    }

    static get() {
        return {
            FORUM_URL: seal.ext.getStringConfig(ext, "论坛地址"),
            FORUM_API_TOKEN: seal.ext.getStringConfig(ext, "论坛API Token"),
            FORUM_SECRET_KEY: seal.ext.getStringConfig(ext, "论坛签名密钥"),
        }
    }
}
