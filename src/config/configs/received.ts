// 消息接收配置：接收范围/忽略条件与正则
import { ext } from "../config";
import { getRegexConfig } from "../config";

export default class ReceivedConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "接收图片", true, "开启后接收并识别图片消息（需要配置图片模型）", "消息接收");
        seal.ext.registerBoolConfig(ext, "接收指令消息", false, "开启后指令消息也会计入上下文（指令仍会执行）", "消息接收");
        seal.ext.registerBoolConfig(ext, "接收骰子发送的消息", false, "开启后机器人自己发送的消息也会进入上下文", "消息接收");
        seal.ext.registerBoolConfig(ext, "忽略私聊消息", false, "开启后私聊消息不触发 AI", "消息接收");
        seal.ext.registerStringConfig(ext, "忽略消息豹语条件", '0', "0 不忽略；1 忽略所有消息；也可填豹语表达式，命中为 1 时忽略", "消息接收");
        seal.ext.registerTemplateConfig(ext, "忽略消息正则表达式", [
            "^忽略这句话$"
        ], "每行一个正则，匹配到的消息不触发 AI 也不计入上下文；修改后保存并重载 js", "消息接收");
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
