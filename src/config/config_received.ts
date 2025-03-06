import { ConfigManager } from "./config";

export class ReceivedConfig {
    static ext: seal.ExtInfo;

    static register() {
        ReceivedConfig.ext = ConfigManager.getExt('aiplugin4_3:消息接收与触发');

        seal.ext.registerBoolConfig(ReceivedConfig.ext, "是否录入指令消息", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "是否录入所有骰子发送的消息", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "私聊内不可用", false, "");
        seal.ext.registerStringConfig(ReceivedConfig.ext, "非指令触发需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerTemplateConfig(ReceivedConfig.ext, "非指令消息触发正则表达式", [
            "\\[CQ:at,qq=748569109\\]",
            "^正确正确确"
        ], "使用正则表达式进行匹配");
    }

    static get() {
        return {
            allcmd: seal.ext.getBoolConfig(ReceivedConfig.ext, "是否录入指令消息"),
            allmsg: seal.ext.getBoolConfig(ReceivedConfig.ext, "是否录入所有骰子发送的消息"),
            disabledInPrivate: seal.ext.getBoolConfig(ReceivedConfig.ext, "私聊内不可用"),
            keyWords: seal.ext.getTemplateConfig(ReceivedConfig.ext, "非指令消息触发正则表达式"),
            condition: seal.ext.getStringConfig(ReceivedConfig.ext, "非指令触发需要满足的条件")
        }
    }
}