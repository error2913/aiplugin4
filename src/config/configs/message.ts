// 对话配置：角色设定/示例对话/轮数/插入间隔/展示号码/压缩阈值
import Config from "../config";

export default class MessageConfig {
    static ext: seal.ExtInfo;

    static register() {
        MessageConfig.ext = Config.getExt('对话');

        seal.ext.registerTemplateConfig(MessageConfig.ext, "角色设定名称", [
            `测试机器人`
        ], '请求时会按照豹语变量`$gSYSPROMPT`进行选择，与下面的角色设定对应')
        seal.ext.registerTemplateConfig(MessageConfig.ext, "角色扮演设定", [
            `你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。`
        ], '')
        seal.ext.registerTemplateConfig(MessageConfig.ext, "示例对话", [""], "role顺序为user和assistant轮流出现");
        seal.ext.registerIntConfig(MessageConfig.ext, "对话保存轮数", 15, "");
        seal.ext.registerIntConfig(MessageConfig.ext, "插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，示例对话不计入轮数");
        seal.ext.registerBoolConfig(MessageConfig.ext, "展示号码", true, "在工具描述/上下文显示中使用QQ号");
        seal.ext.registerIntConfig(MessageConfig.ext, "消息压缩阈值", 800, "用户消息超过该字符数时，使用压缩智能体压缩后存入上下文");
    }

    static get() {
        return {
            ROLE_NAMES: seal.ext.getTemplateConfig(MessageConfig.ext, "角色设定名称"),
            INSTRUCTIONS: seal.ext.getTemplateConfig(MessageConfig.ext, "角色扮演设定"),
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(MessageConfig.ext, "示例对话"),
            MAX_ROUNDS: seal.ext.getIntConfig(MessageConfig.ext, "对话保存轮数"),
            INSERT_COUNT: seal.ext.getIntConfig(MessageConfig.ext, "插入system message间隔轮数"),
            SHOW_NUMBER: seal.ext.getBoolConfig(MessageConfig.ext, "展示号码"),
            COMPRESS_THRESHOLD: seal.ext.getIntConfig(MessageConfig.ext, "消息压缩阈值")
        }
    }
}
