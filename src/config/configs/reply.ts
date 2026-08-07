// 回复配置：引用/最大字数/去空白/复读检测/过滤正则与模板
import Handlebars from "handlebars";

import Logger from "../../logger";
import { ext } from "../config";
import { getRegexConfig } from "../config";

export default class ReplyConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "回复引用", false, "开启将会引用触发该条回复的消息", "回复");
        seal.ext.registerIntConfig(ext, "回复最大字数", 5000, "回复的最大字数，防止 max_tokens 限制不起效", "回复");
        seal.ext.registerBoolConfig(ext, "回复文本去除首尾空白字符", true, "发送前去除回复首尾空白", "回复");
        seal.ext.registerBoolConfig(ext, "分段发送延时", true, "流式/非流式输出共用，消息间隔是否开启延时防止乱序", "回复");
        seal.ext.registerIntConfig(ext, "分段发送基础延时/ms", 350, "流式/非流式输出共用，从第二条消息开始每条发送前等待的毫秒数", "回复");
        seal.ext.registerIntConfig(ext, "分段发送含图额外延时/ms", 250, "流式/非流式输出共用，当消息包含图片时额外增加的等待毫秒数", "回复");
        seal.ext.registerBoolConfig(ext, "禁止回复复读", false, "检测到复读时停止回复", "回复");
        seal.ext.registerFloatConfig(ext, "视作复读的最低相似度", 0.8, "与上一条回复的相似度达到该值视为复读", "回复");
        seal.ext.registerTemplateConfig(ext, "回复消息过滤正则表达式", [
            "<think>[\\s\\S]*<\\/think>|<[\\|│｜]?func[^>]{0,9}$|[<＜][\\|│｜](?!at|poke|quote|img|face).*?(?:[\\|│｜][>＞]|[\\|│｜>＞])|^[^\\|│｜>＞]{0,10}[\\|│｜][>＞]|[<＜][\\|│｜][^\\|│｜>＞]{0,20}$",
            "<[\\|│｜]?function(?:_call)?>[\\s\\S]*<\\/function(?:_call)?>",
            "```.*\\n([\\s\\S]*?)\\n```",
            "\\*\\*(.*?)\\*\\*",
            "~~(.*?)~~",
            "(?:^|\\n)\\s{0,12}[-*]\\s+(.*)",
            "(?:^|\\n)#{1,6}\\s+(.*)"
        ], "每行一个正则，0 为整条匹配、1 之后为捕获组，可在下方模板用 {{{match.[数字]}}} 访问", "回复");
        seal.ext.registerTemplateConfig(ext, "正则处理上下文消息模板", [
            "",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}",
            "{{{match.[0]}}}"
        ], "按「回复消息过滤正则表达式」顺序逐条对应；第 0 行处理整条匹配，其余行对应捕获组；空行保留原文；支持 {{{match.[N]}}} 变量", "回复");
        seal.ext.registerTemplateConfig(ext, "正则处理回复消息模板", [
            "",
            "",
            "\n{{{match.[1]}}}\n",
            "{{{match.[1]}}}",
            "{{{match.[1]}}}",
            "\n{{{match.[1]}}}",
            "\n{{{match.[1]}}}"
        ], "同上，替换回复消息文本；与「回复消息过滤正则表达式」顺序逐条对应；空行保留原文", "回复");
    }

    static get() {
        return {
            QUOTE_REPLY: seal.ext.getBoolConfig(ext, "回复引用"),
            MAX_CHARS: seal.ext.getIntConfig(ext, "回复最大字数"),
            TRIM: seal.ext.getBoolConfig(ext, "回复文本去除首尾空白字符"),
            SEGMENT_DELAY_ENABLED: seal.ext.getBoolConfig(ext, "分段发送延时"),
            SEGMENT_DELAY_MS: seal.ext.getIntConfig(ext, "分段发送基础延时/ms"),
            SEGMENT_IMAGE_EXTRA_DELAY_MS: seal.ext.getIntConfig(ext, "分段发送含图额外延时/ms"),
            STOP_REPEAT: seal.ext.getBoolConfig(ext, "禁止回复复读"),
            REPEAT_SIMILARITY: seal.ext.getFloatConfig(ext, "视作复读的最低相似度"),
            FILTER_REGEX: getRegexConfig(ext, "回复消息过滤正则表达式"),
            FILTER_REGEXES: getRegexesConfig("回复消息过滤正则表达式"),
            CONTEXT_TEMPLATES: getHandlebarsTemplatesConfig("正则处理上下文消息模板"),
            REPLY_TEMPLATES: getHandlebarsTemplatesConfig("正则处理回复消息模板")
        }
    }
}

function getRegexesConfig(key: string): RegExp[] {
    return seal.ext.getTemplateConfig(ext, key).map(x => {
        try {
            return new RegExp(x);
        } catch (e) {
            Logger.error(`正则表达式错误，内容:${x}，错误信息:${e instanceof Error ? e.message : String(e)}`);
            return /(?!)/;
        }
    });
}

function getHandlebarsTemplatesConfig(key: string): HandlebarsTemplateDelegate<any>[] {
    return seal.ext.getTemplateConfig(ext, key).map(x => {
        try {
            return Handlebars.compile(x || '');
        } catch (e) {
            Logger.error(`模板${key}解析失败，已跳过该条配置: ${e instanceof Error ? e.message : String(e)}`);
            return () => '';
        }
    });
}
