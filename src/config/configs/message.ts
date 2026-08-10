// 对话配置：角色设定/示例对话/轮数/插入间隔/压缩阈值
import { ext } from "../config";
export default class MessageConfig {

    static register() {

        seal.ext.registerTemplateConfig(ext, "角色设定名称", [
            `测试机器人`
        ], '每行一个角色名；请求时通过豹语变量 $gSYSPROMPT 选择，与「角色扮演设定」按行对应；修改后保存并重载 js', "对话")
        seal.ext.registerTemplateConfig(ext, "角色扮演设定", [
            `你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。`
        ], '每行一个角色的扮演设定，与「角色设定名称」按行对应；修改后保存并重载 js', "对话")
        seal.ext.registerTemplateConfig(ext, "示例对话", [""], "每行一条示例对话，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "对话");
        seal.ext.registerIntConfig(ext, "对话保存轮数", 15, "每个会话最多保存的对话轮数，超出后从最早消息开始丢弃", "对话");
        seal.ext.registerIntConfig(ext, "上下文最大token", 0, "0为不限制；超过后从最早的消息开始丢弃", "对话");
        seal.ext.registerIntConfig(ext, "插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，示例对话不计入轮数", "对话");
        seal.ext.registerIntConfig(ext, "消息压缩阈值", 2000, "用户消息（含连续多条合并后）超过该字符数时，使用压缩智能体压缩后存入上下文", "对话");
    }

    static get() {
        return {
            ROLE_NAMES: seal.ext.getTemplateConfig(ext, "角色设定名称"),
            INSTRUCTIONS: seal.ext.getTemplateConfig(ext, "角色扮演设定"),
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(ext, "示例对话"),
            MAX_ROUNDS: seal.ext.getIntConfig(ext, "对话保存轮数"),
            MAX_CONTEXT_TOKENS: seal.ext.getIntConfig(ext, "上下文最大token"),
            INSERT_COUNT: seal.ext.getIntConfig(ext, "插入system message间隔轮数"),
            COMPRESS_THRESHOLD: seal.ext.getIntConfig(ext, "消息压缩阈值")
        }
    }
}
