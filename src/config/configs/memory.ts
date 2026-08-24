// 记忆配置：长期记忆/观察记忆/知识库（Markdown 模板）
import { ext } from "../config";


export default class MemoryConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "启用长期记忆", true, "开启后对话内容会沉淀为长期记忆", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆上限", 50, "长期记忆条数上限，超出后按分数淘汰", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆展示数量", 5, "构造记忆 prompt 时展示的长期记忆条数", "记忆");
        seal.ext.registerBoolConfig(ext, "启用观察记忆", true, "开启后定期对对话进行观察记忆", "记忆");
        seal.ext.registerIntConfig(ext, "观察记忆上限", 10, "观察记忆条数上限，超出后从最旧的开始淘汰", "记忆");
        seal.ext.registerIntConfig(ext, "观察记忆间隔轮数", 10, "每多少轮对话自动触发一次观察", "记忆");
        seal.ext.registerIntConfig(ext, "观察记忆参与轮数", 10, "每次观察纳入的对话轮数", "记忆");
        seal.ext.registerIntConfig(ext, "核心事实注入条数", 3, "重要性达阈值（80%）的语义记忆常驻注入 prompt 的条数，0为不注入", "记忆");
        seal.ext.registerIntConfig(ext, "记忆巩固间隔(次观察)", 30, "每多少次观察后自动整合重复观察并清理过期记忆，0为关闭", "记忆");
        seal.ext.registerBoolConfig(ext, "启用知识库记忆", false, "开启后把知识库内容注入 system prompt，供对话参考", "记忆");
        seal.ext.registerIntConfig(ext, "知识库注入阈值(字符)", 5000, "知识库总内容不超过该值时全量注入 system prompt；超过时只注入条目索引，需要详情时模型用 kb_read 工具读取。设为 0 时始终只注入索引", "记忆");
        seal.ext.registerBoolConfig(ext, "记忆LLM抽取", false, "Retain 时使用 LLM 抽取原子事实（默认关闭，避免与观察抽取重复）", "记忆");
        seal.ext.registerBoolConfig(ext, "记忆LLM重排", false, "Recall 时使用 LLM 对 RRF 结果重排（较慢，默认关闭）", "记忆");
        seal.ext.registerBoolConfig(ext, "记忆观察合成", true, "Consolidation 时使用 LLM 合成观察记忆（默认开启）", "记忆");
        seal.ext.registerTemplateConfig(ext, "知识库", [
            `# AI 骰娘4 使用指南

## 功能简介
本插件为骰娘接入大模型 API，支持智能对话、TRPG 辅助、记忆与知识库等能力。

## 快速开始
1. 在「模型」页签配置对话模型（TOML 格式）
2. 在「基础」页签开启全局待机或设置触发正则
3. 在群聊或私聊中发送消息（或 @机器人）即可触发对话

## 常用指令
| 指令 | 说明 |
| --- | --- |
| .ai help | 查看全部子命令 |
| .ai model | 查看/切换当前模型 |
| .ai memo status | 查看记忆状态 |

## 引用说明
> 知识库内容为只读：仅管理员可在配置中修改，AI 通过 kb_search / kb_read / kb_list 工具或 .ai kb 指令检索，不能增删。

## 代码块示例
\`\`\`
.ai kb list
.ai kb search 触发方式
\`\`\`

## 注意事项
- 修改知识库后自动生效（缓存最多 1 分钟）
- 超长文档会按段落自动分块，块间保留少量重叠`
        ], "每条配置项一份完整 Markdown 文档（可直接粘贴 .md 文件内容）。\n格式：文档用 # 一级标题作为条目标题，## / ### 作为小节标题，支持列表、表格、引用、代码块等标准 Markdown 语法；无标题时自动用条目序号命名；超长文档按段落自动分块（单块约 800 字符，块间保留少量重叠）。\n格式定义见 https://commonmark.org/help/ （CommonMark 官方规范，国内可访问）。\n知识库为只读数据：内容只能由管理员在配置里修改，AI 通过 kb_search / kb_read / kb_list 工具或 .ai kb 指令检索，不能增删。\n下方默认值即单个完整示例（含标题/小节/列表/表格/引用/代码块），可修改为实际知识内容。修改后自动生效（缓存最多 1 分钟）", "记忆");
    }

    static get() {
        return {
            MEMORY: seal.ext.getBoolConfig(ext, "启用长期记忆"),
            MEMORY_LIMIT: seal.ext.getIntConfig(ext, "长期记忆上限"),
            MEMORY_SHOW_NUMBER: seal.ext.getIntConfig(ext, "长期记忆展示数量"),
            SUMMARY: seal.ext.getBoolConfig(ext, "启用观察记忆"),
            SUMMARY_LIMIT: seal.ext.getIntConfig(ext, "观察记忆上限"),
            SUMMARY_INTERVAL: seal.ext.getIntConfig(ext, "观察记忆间隔轮数"),
            SUMMARY_SIZE: seal.ext.getIntConfig(ext, "观察记忆参与轮数"),
            CORE_FACT_NUMBER: seal.ext.getIntConfig(ext, "核心事实注入条数"),
            CONSOLIDATE_INTERVAL: seal.ext.getIntConfig(ext, "记忆巩固间隔(次观察)"),
            KNOWLEDGE: seal.ext.getBoolConfig(ext, "启用知识库记忆"),
            KNOWLEDGE_INJECT_THRESHOLD: seal.ext.getIntConfig(ext, "知识库注入阈值(字符)"),
            KNOWLEDGE_ITEMS: seal.ext.getTemplateConfig(ext, "知识库"),
            MEMORY_LLM_EXTRACT: seal.ext.getBoolConfig(ext, "记忆LLM抽取"),
            MEMORY_LLM_RERANK: seal.ext.getBoolConfig(ext, "记忆LLM重排"),
            MEMORY_OBSERVATION_SYNTH: seal.ext.getBoolConfig(ext, "记忆观察合成")
        }
    }
}




