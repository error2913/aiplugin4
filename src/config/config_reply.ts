import { ConfigManager } from "./config";

export class ReplyConfig {
    static register() {
        seal.ext.registerBoolConfig(ConfigManager.ext, "回复是否引用", false, "");
        seal.ext.registerIntConfig(ConfigManager.ext, "回复最大字数", 1000, "防止最大Tokens限制不起效");
        seal.ext.registerBoolConfig(ConfigManager.ext, "禁止AI复读", false, "");
        seal.ext.registerFloatConfig(ConfigManager.ext, "视作复读的最低相似度", 0.8, "");
        seal.ext.registerTemplateConfig(ConfigManager.ext, "过滤上下文正则表达式", [
            "<[\\|｜].*?[\\|｜]?>",
            "^<think>.*?</think>"
        ], "回复加入上下文时，将符合正则表达式的内容删掉");
        seal.ext.registerTemplateConfig(ConfigManager.ext, "过滤回复正则表达式", [
            "<[\\|｜].*?[\\|｜]?>",
            "^<think>.*?</think>"
        ], "发送回复时，将符合正则表达式的内容删掉");
    }

    static get() {
        return {
            maxChar: seal.ext.getIntConfig(ConfigManager.ext, "回复最大字数"),
            replymsg: seal.ext.getBoolConfig(ConfigManager.ext, "回复是否引用"),
            stopRepeat: seal.ext.getBoolConfig(ConfigManager.ext, "禁止AI复读"),
            similarityLimit: seal.ext.getFloatConfig(ConfigManager.ext, "视作复读的最低相似度"),
            filterContextTemplate: seal.ext.getTemplateConfig(ConfigManager.ext, "过滤上下文正则表达式"),
            filterReplyTemplate: seal.ext.getTemplateConfig(ConfigManager.ext, "过滤回复正则表达式")
        }
    }
}