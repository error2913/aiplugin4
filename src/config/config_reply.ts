import { ConfigManager } from "./config";

export class ReplyConfig {
    static ext: seal.ExtInfo;

    static register() {
        ReplyConfig.ext = ConfigManager.getExt('aiplugin4_4:回复');

        seal.ext.registerBoolConfig(ReplyConfig.ext, "回复是否引用", false, "开启将会引用触发该条回复的消息");
        seal.ext.registerIntConfig(ReplyConfig.ext, "回复最大字数", 5000, "防止最大tokens限制不起效");
        seal.ext.registerBoolConfig(ReplyConfig.ext, "禁止AI复读", false, "");
        seal.ext.registerFloatConfig(ReplyConfig.ext, "视作复读的最低相似度", 0.8, "");
        seal.ext.registerTemplateConfig(ReplyConfig.ext, "回复消息过滤正则表达式", [
            "<think>[\\s\\S]*<\\/think>|<func[^>]{0,9}$|[<＜][\\|│｜](?!at|poke|quote|img).*?(?:[\\|│｜][>＞]|[\\|│｜>＞])|^[^\\|│｜>＞]{0,10}[\\|│｜][>＞]|[<＜][\\|│｜][^\\|│｜>＞]{0,20}$",
            "<function(?:_call)?>[\\s\\S]*<\\/function(?:_call)?>",
            "```.*\\n([\\s\\S]*?)\\n```",
            "\\*\\*(.*?)\\*\\*",
            "~~(.*?)~~",
            "(?:^|\\n)\\s{0,12}[-*]\\s+(.*)",
            "(?:^|\\n)#{1,6}\\s+(.*)"
        ], "匹配在下面通过{{{match.[数字]}}}访问，0为匹配到的消息，1之后为捕获组");
        seal.ext.registerTemplateConfig(ReplyConfig.ext, "正则处理上下文消息模板", [
            "",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}"
        ], "替换匹配到的文本，与什么正则表达式序号对应");
        seal.ext.registerTemplateConfig(ReplyConfig.ext, "正则处理回复消息模板", [
            "",
            "",
            "\n{{{match.[1]}}}\n",
            "{{{match.[1]}}}",
            "{{{match.[1]}}}",
            "\n{{{match.[1]}}}",
            "\n{{{match.[1]}}}"
        ], "替换匹配到的文本，与上面正则表达式序号对应");
        seal.ext.registerBoolConfig(ReplyConfig.ext, "回复文本是否去除首尾空白字符", true, "");
    }

    static get() {
        return {
            maxChar: seal.ext.getIntConfig(ReplyConfig.ext, "回复最大字数"),
            replymsg: seal.ext.getBoolConfig(ReplyConfig.ext, "回复是否引用"),
            stopRepeat: seal.ext.getBoolConfig(ReplyConfig.ext, "禁止AI复读"),
            similarityLimit: seal.ext.getFloatConfig(ReplyConfig.ext, "视作复读的最低相似度"),
            filterRegexes: seal.ext.getTemplateConfig(ReplyConfig.ext, "回复消息过滤正则表达式"),
            contextTemplate: seal.ext.getTemplateConfig(ReplyConfig.ext, "正则处理上下文消息模板"),
            replyTemplate: seal.ext.getTemplateConfig(ReplyConfig.ext, "正则处理回复消息模板"),
            isTrim: seal.ext.getBoolConfig(ReplyConfig.ext, "回复文本是否去除首尾空白字符")
        }
    }
}