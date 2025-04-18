import { ConfigManager } from "./config";

export class BackendConfig {
    static ext: seal.ExtInfo;

    static register() {
        BackendConfig.ext = ConfigManager.getExt('aiplugin4_6:后端');

        seal.ext.registerStringConfig(BackendConfig.ext, "流式输出", "http://localhost:3010", '自行搭建或使用他人提供的后端');
        seal.ext.registerStringConfig(BackendConfig.ext, "图片转base64", "http://162.14.109.222:46678", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "联网搜索", "http://162.14.109.222:8080", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "网页读取", "http://162.14.109.222:46799", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "用量图表", "http://42.193.236.17:3009", '可自行搭建');
    }

    static get() {
        return {
            streamUrl: seal.ext.getStringConfig(BackendConfig.ext, "流式输出"),
            imageTobase64Url: seal.ext.getStringConfig(BackendConfig.ext, "图片转base64"),
            webSearchUrl: seal.ext.getStringConfig(BackendConfig.ext, "联网搜索"),
            webReadUrl: seal.ext.getStringConfig(BackendConfig.ext, "网页读取"),
            usageChartUrl: seal.ext.getStringConfig(BackendConfig.ext, "用量图表")
        }
    }
}