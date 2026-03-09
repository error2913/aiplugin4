import { Config } from "../config";

export default class BackendConfig {
    static ext: seal.ExtInfo;

    static register() {
        BackendConfig.ext = Config.getExt('aiplugin4:后端');

        seal.ext.registerStringConfig(BackendConfig.ext, "流式输出", "http://localhost:3010", '自行搭建或使用他人提供的后端');
        seal.ext.registerStringConfig(BackendConfig.ext, "图片转base64", "https://urltobase64.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "联网搜索", "https://searxng.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "网页读取", "https://webread.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "用量图表", "http://usagechart.error2913.com", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "md和html图片渲染", "https://md.fishwhite.top", '可自行搭建');
    }

    static get() {
        return {
            STREAM: seal.ext.getStringConfig(BackendConfig.ext, "流式输出"),
            IMAGE_TO_BASE64: seal.ext.getStringConfig(BackendConfig.ext, "图片转base64"),
            WEB_SEARCH: seal.ext.getStringConfig(BackendConfig.ext, "联网搜索"),
            WEB_READ: seal.ext.getStringConfig(BackendConfig.ext, "网页读取"),
            USAGE_CHART: seal.ext.getStringConfig(BackendConfig.ext, "用量图表"),
            RENDER: seal.ext.getStringConfig(BackendConfig.ext, "md和html图片渲染")
        }
    }
}
