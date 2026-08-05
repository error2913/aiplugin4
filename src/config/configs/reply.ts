// 回复配置：引用/最大字数/去空白/复读检测/过滤正则与模板
import Handlebars from "handlebars";
import Logger from "../../logger";
import Config, { getRegexConfig } from "../config";

export default class ReplyConfig {
    static ext: seal.ExtInfo;

    static register() {
        ReplyConfig.ext = Config.getExt('回复');

        seal.ext.registerBoolConfig(ReplyConfig.ext, "回复引用", false, "开启将会引用触发该条回复的消息");
        seal.ext.registerIntConfig(ReplyConfig.ext, "回复最大字数", 5000, "防止最大tokens限制不起效");
        seal.ext.registerBoolConfig(ReplyConfig.ext, "回复文本去除首尾空白字符", true, "");
        seal.ext.registerBoolConfig(ReplyConfig.ext, "禁止回复复读", false, "");
        seal.ext.registerFloatConfig(ReplyConfig.ext, "视作复读的最低相似度", 0.8, "");
        seal.ext.registerTemplateConfig(ReplyConfig.ext, "回复消息过滤正则表达式", [
            "<think>[\\s\\S]*<\\/think>|<[\\|│｜]?func[^>]{0,9}$|[<＜][\\|│｜](?!at|poke|quote|img|face).*?(?:[\\|│｜][>＞]|[\\|│｜>＞])|^[^\\|│｜>＞]{0,10}[\\|│｜][>＞]|[<＜][\\|│｜][^\\|│｜>＞]{0,20}$",
            "<[\\|│｜]?function(?:_call)?>[\\s\\S]*<\\/function(?:_call)?>",
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
    }

    static get() {
        return {
            QUOTE_REPLY: seal.ext.getBoolConfig(ReplyConfig.ext, "回复引用"),
            MAX_CHARS: seal.ext.getIntConfig(ReplyConfig.ext, "回复最大字数"),
            TRIM: seal.ext.getBoolConfig(ReplyConfig.ext, "回复文本去除首尾空白字符"),
            STOP_REPEAT: seal.ext.getBoolConfig(ReplyConfig.ext, "禁止回复复读"),
            REPEAT_SIMILARITY: seal.ext.getFloatConfig(ReplyConfig.ext, "视作复读的最低相似度"),
            FILTER_REGEX: getRegexConfig(ReplyConfig.ext, "回复消息过滤正则表达式"),
            FILTER_REGEXES: getRegexesConfig("回复消息过滤正则表达式"),
            CONTEXT_TEMPLATES: getHandlebarsTemplatesConfig("正则处理上下文消息模板"),
            REPLY_TEMPLATES: getHandlebarsTemplatesConfig("正则处理回复消息模板")
        }
    }
}

function getRegexesConfig(key: string): RegExp[] {
    return seal.ext.getTemplateConfig(ReplyConfig.ext, key).map(x => {
        try {
            return new RegExp(x);
        } catch (e) {
            Logger.error(`正则表达式错误，内容:${x}，错误信息:${e.message}`);
            return /(?!)/;
        }
    });
}

function getHandlebarsTemplatesConfig(key: string): HandlebarsTemplateDelegate<any>[] {
    return seal.ext.getTemplateConfig(ReplyConfig.ext, key).map(x => Handlebars.compile(x || ''));
}