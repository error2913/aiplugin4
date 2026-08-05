// 消息接收配置：接收范围/忽略条件与正则
import { ext } from "../config";
import { getRegexConfig } from "../config";

export default class ReceivedConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "接收图片", true, "", "消息接收");
        seal.ext.registerBoolConfig(ext, "接收指令消息", false, "", "消息接收");
        seal.ext.registerBoolConfig(ext, "接收骰子发送的消息", false, "", "消息接收");
        seal.ext.registerBoolConfig(ext, "忽略私聊消息", false, "", "消息接收");
        seal.ext.registerStringConfig(ext, "忽略消息豹语条件", '0', "为1时忽略所有消息；可填豹语表达式，命中为1时忽略", "消息接收");
        seal.ext.registerTemplateConfig(ext, "忽略消息正则表达式", [
            "^忽略这句话$"
        ], "匹配的消息将被忽略", "消息接收");
    }

    static get() {
        return {
            RECEIVE_IMAGE: seal.ext.getBoolConfig(ext, "接收图片"),
            RECEIVE_CMD: seal.ext.getBoolConfig(ext, "接收指令消息"),
            RECEIVE_MSG_BY_BOT: seal.ext.getBoolConfig(ext, "接收骰子发送的消息"),
            IGNORE_PRIVATE: seal.ext.getBoolConfig(ext, "忽略私聊消息"),
            IGNORE_CONDITION: seal.ext.getStringConfig(ext, "忽略消息豹语条件"),
            IGNORE_REGEX: getRegexConfig(ext, "忽略消息正则表达式")
        }
    }
}
