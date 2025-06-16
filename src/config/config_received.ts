import { ConfigManager } from "./config";

export class ReceivedConfig {
    static ext: seal.ExtInfo;

    static register() {
        ReceivedConfig.ext = ConfigManager.getExt('aiplugin4_3:消息接收与触发');

        seal.ext.registerBoolConfig(ReceivedConfig.ext, "是否录入指令消息", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "是否录入所有骰子发送的消息", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "私聊内不可用", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "是否开启全局待机", false, "开启后，全局的ai将进入待机状态，可能造成性能问题");
        seal.ext.registerStringConfig(ReceivedConfig.ext, "非指令触发需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerTemplateConfig(ReceivedConfig.ext, "非指令消息触发正则表达式", [
            "\\[CQ:at,qq=748569109\\]",
            "^正确.*[。？！?!]$"
        ], "");
        seal.ext.registerTemplateConfig(ReceivedConfig.ext, "非指令消息忽略正则表达式", [
            "^忽略这句话$"
        ], "匹配的消息不会接收录入上下文");
        seal.ext.registerIntConfig(ReceivedConfig.ext, "触发次数上限", 3, "");
        seal.ext.registerIntConfig(ReceivedConfig.ext, "触发次数补充间隔/s", 3, "");
    }

    static get() {
        return {
            allcmd: seal.ext.getBoolConfig(ReceivedConfig.ext, "是否录入指令消息"),
            allmsg: seal.ext.getBoolConfig(ReceivedConfig.ext, "是否录入所有骰子发送的消息"),
            disabledInPrivate: seal.ext.getBoolConfig(ReceivedConfig.ext, "私聊内不可用"),
            globalStandby: seal.ext.getBoolConfig(ReceivedConfig.ext, "是否开启全局待机"),
            triggerRegexes: seal.ext.getTemplateConfig(ReceivedConfig.ext, "非指令消息触发正则表达式"),
            ignoreRegexes: seal.ext.getTemplateConfig(ReceivedConfig.ext, "非指令消息忽略正则表达式"),
            triggerCondition: seal.ext.getStringConfig(ReceivedConfig.ext, "非指令触发需要满足的条件"),
            bucketLimit: seal.ext.getIntConfig(ReceivedConfig.ext, "触发次数上限"),
            fillInterval: seal.ext.getIntConfig(ReceivedConfig.ext, "触发次数补充间隔/s")
        }
    }
}