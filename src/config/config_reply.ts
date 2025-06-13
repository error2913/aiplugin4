import { ConfigManager } from "./config";

export class ReplyConfig {
    static ext: seal.ExtInfo;

    static register() {
        ReplyConfig.ext = ConfigManager.getExt('aiplugin4_4:回复');

        seal.ext.registerBoolConfig(ReplyConfig.ext, "回复是否引用", false, "开启将会引用触发该条回复的消息");
        seal.ext.registerIntConfig(ReplyConfig.ext, "回复最大字数", 1000, "防止最大tokens限制不起效");
        seal.ext.registerBoolConfig(ReplyConfig.ext, "禁止AI复读", false, "");
        seal.ext.registerFloatConfig(ReplyConfig.ext, "视作复读的最低相似度", 0.8, "");
        seal.ext.registerTemplateConfig(ReplyConfig.ext, "回复消息过滤正则表达式", [
            "<think>[\\s\\S]*?<\\/think>",
            "(<function_call>[\\s\\S]*?<\\/function_call>)",
            "[<＜]\\s?[\\|│｜](?:from|msg_id).*?(?:[\\|│｜]\\s?[>＞<＜]|[\\|│｜]|\\s?[>＞<＜])",
            "([<＜]\\s?[\\|│｜](?!@|poke|quote|img).*?(?:[\\|│｜]\\s?[>＞<＜]|[\\|│｜]|\\s?[>＞<＜]))"
        ], "回复加入上下文时，将捕获组内文本保留，发送回复时，将捕获组内文本删除");
        seal.ext.registerBoolConfig(ReplyConfig.ext, "回复文本是否去除首尾空白字符", true, "");
    }

    static get() {
        return {
            maxChar: seal.ext.getIntConfig(ReplyConfig.ext, "回复最大字数"),
            replymsg: seal.ext.getBoolConfig(ReplyConfig.ext, "回复是否引用"),
            stopRepeat: seal.ext.getBoolConfig(ReplyConfig.ext, "禁止AI复读"),
            similarityLimit: seal.ext.getFloatConfig(ReplyConfig.ext, "视作复读的最低相似度"),
            filterRegexes: seal.ext.getTemplateConfig(ReplyConfig.ext, "回复消息过滤正则表达式"),
            isTrim: seal.ext.getBoolConfig(ReplyConfig.ext, "回复文本是否去除首尾空白字符")
        }
    }
}