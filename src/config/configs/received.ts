import { Config, getRegexConfig } from "../config";

export default class ReceivedConfig {
    static ext: seal.ExtInfo;

    static register() {
        ReceivedConfig.ext = Config.getExt('aiplugin4:消息接收');

        seal.ext.registerBoolConfig(ReceivedConfig.ext, "接收图片", true, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "接收指令消息", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "接收骰子发送的消息", false, "");
        seal.ext.registerBoolConfig(ReceivedConfig.ext, "忽略私聊消息", false, "");
        seal.ext.registerStringConfig(ReceivedConfig.ext, "忽略消息豹语条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerTemplateConfig(ReceivedConfig.ext, "忽略消息正则表达式", [
            "^忽略这句话$"
        ], "匹配的消息将被忽略");
    }

    static get() {
        return {
            RECEIVE_IMAGE: seal.ext.getBoolConfig(ReceivedConfig.ext, "接收图片"),
            RECEIVE_CMD: seal.ext.getBoolConfig(ReceivedConfig.ext, "接收指令消息"),
            RECEIVE_MSG_BY_BOT: seal.ext.getBoolConfig(ReceivedConfig.ext, "接收骰子发送的消息"),
            IGNORE_PRIVATE: seal.ext.getBoolConfig(ReceivedConfig.ext, "忽略私聊消息"),
            IGNORE_CONDITION: seal.ext.getStringConfig(ReceivedConfig.ext, "忽略消息豹语条件"),
            IGNORE_REGEX: getRegexConfig(ReceivedConfig.ext, "忽略消息正则表达式")
        }
    }
}