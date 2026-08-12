// 记忆配置：长期记忆/总结记忆/知识库（Markdown 模板）
import { ext } from "../config";


export default class MemoryConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "启用长期记忆", true, "开启后对话内容会沉淀为长期记忆", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆上限", 50, "长期记忆条数上限，超出后按分数淘汰", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆展示数量", 5, "构造记忆 prompt 时展示的长期记忆条数", "记忆");
        seal.ext.registerBoolConfig(ext, "启用总结记忆", true, "开启后定期对对话进行总结记忆", "记忆");
        seal.ext.registerIntConfig(ext, "总结记忆上限", 10, "总结记忆条数上限", "记忆");
        seal.ext.registerIntConfig(ext, "总结记忆间隔轮数", 10, "每多少轮对话自动触发一次总结", "记忆");
        seal.ext.registerIntConfig(ext, "总结记忆参与轮数", 10, "每次总结纳入的对话轮数", "记忆");
        seal.ext.registerBoolConfig(ext, "启用知识库记忆", false, "开启后把知识库内容注入 system prompt，供对话参考", "记忆");
        seal.ext.registerIntConfig(ext, "知识库注入阈值(字符)", 5000, "知识库总内容不超过该值时全量注入 system prompt；超过时只注入条目索引，需要详情时模型用 kb_read 工具读取。设为 0 时始终只注入索引", "记忆");
        seal.ext.registerTemplateConfig(ext, "知识库", [
            `# 插件使用说明

## 触发方式
在群聊或私聊中发送消息即可触发对话，支持 @机器人 触发。`
        ], "每条配置项一份完整 Markdown 文档（可直接粘贴 .md 文件内容）。\\n# 作为条目标题、## / ### 作为小节标题，无标题时自动用条目序号命名；超长文档按段落自动分块（单块约 800 字符、块间保留少量重叠）。\\n知识库为只读数据：内容只能由管理员在配置里修改，AI 通过 kb_search / kb_read / kb_list 工具或 .ai kb 指令检索，不能增删。\\n下方默认值即简洁示例，可修改为实际知识内容。修改后自动生效（缓存最多 1 分钟）", "记忆");
    }

    static get() {
        return {
            MEMORY: seal.ext.getBoolConfig(ext, "启用长期记忆"),
            MEMORY_LIMIT: seal.ext.getIntConfig(ext, "长期记忆上限"),
            MEMORY_SHOW_NUMBER: seal.ext.getIntConfig(ext, "长期记忆展示数量"),
            SUMMARY: seal.ext.getBoolConfig(ext, "启用总结记忆"),
            SUMMARY_LIMIT: seal.ext.getIntConfig(ext, "总结记忆上限"),
            SUMMARY_INTERVAL: seal.ext.getIntConfig(ext, "总结记忆间隔轮数"),
            SUMMARY_SIZE: seal.ext.getIntConfig(ext, "总结记忆参与轮数"),
            KNOWLEDGE: seal.ext.getBoolConfig(ext, "启用知识库记忆"),
            KNOWLEDGE_INJECT_THRESHOLD: seal.ext.getIntConfig(ext, "知识库注入阈值(字符)"),
            KNOWLEDGE_ITEMS: seal.ext.getTemplateConfig(ext, "知识库")
        }
    }
}
