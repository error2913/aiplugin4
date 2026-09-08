// 知识库配置（独立「知识库」页签）：开关/注入阈值/Markdown 模板
import { ext } from "../config";
import { KNOWLEDGE_BASE_DEFAULTS } from "../static_config/knowledge_base_defaults";

export default class KnowledgeBaseConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "启用知识库记忆", true, "开启后把知识库内容注入 system prompt，供对话参考", "知识库");
        seal.ext.registerTemplateConfig(ext, "知识库", [...KNOWLEDGE_BASE_DEFAULTS], "每条配置项一份完整 Markdown 文档（可直接粘贴 .md 文件内容）。\n格式：文档以 --- 开头的 YAML frontmatter 写 name（库名，必填）/ description（库描述，可选）/ platform（可选平台白名单数组，如 [QQ, DISCORD]，[] 或省略 = 所有平台），正文为文档内容，支持列表、表格、引用、代码块等标准 Markdown 语法；# 一级标题为一个条目（子条目），##/### 为该条目下的小节（用于逐条帮助时：扩展名作 #、命令作 ##）；无 frontmatter 时自动用 # 一级标题作为库名、正文首段作为描述，无标题时用条目序号命名；超长文档按段落自动分块（单块约 800 字符，块间保留少量重叠）。\n格式定义见 https://commonmark.org/help/ （CommonMark 官方规范，国内可访问）。\n知识库为只读数据：内容只能由管理员在配置里修改，AI 通过 knowledge_search / knowledge_read / knowledge_list / knowledge_docs 工具检索，不能增删；管理员可用 .ai kb 子命令查看/开关（按会话）/refresh。\n默认提供三个库：核心指令（SealDice 核心指令调用帮助）、扩展指令（fun/story/coc7/deck/dnd5e/log 各扩展为子条目、命令为小节）、ob11-api（OB11 API 调用规范，frontmatter 限定 platform: [QQ]，仅 QQ 平台可见）；可修改或增删条目。修改后用 .ai kb refresh 生效（或重载 JS）", "知识库");
    }

    static get() {
        return {
            KNOWLEDGE: seal.ext.getBoolConfig(ext, "启用知识库记忆"),
            KNOWLEDGE_ITEMS: seal.ext.getTemplateConfig(ext, "知识库")
        }
    }
}
