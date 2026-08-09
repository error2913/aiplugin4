// 工具配置：函数调用开关/提示词工程/上限/禁用与默认关闭
import { ext } from "../config";
export default class ToolConfig {
    static register() {

        seal.ext.registerBoolConfig(ext, "开启调用函数功能", true, "总开关；关闭后 AI 无法调用任何工具，仅保留普通对话", "工具");
        seal.ext.registerBoolConfig(ext, "切换为提示词工程", false, "API在不支持function calling功能的时候开启", "工具");
        seal.ext.registerBoolConfig(ext, "拉黑前需要骰主确认", true, "AI 建议拉黑时需骰主确认后才生效；关闭后 AI 可直接拉黑", "工具");
        seal.ext.registerIntConfig(ext, "允许连续调用函数次数", 5, "单次回复流程中允许连续调用工具的次数，防止无限循环", "工具");
        seal.ext.registerIntConfig(ext, "工具响应压缩触发字数", 10000, "工具返回结果超过该字数时压缩后再存入上下文；设为 0 不压缩", "工具");
        seal.ext.registerTemplateConfig(ext, "禁止调用的函数", [''], "每行一个禁止 AI 调用的函数名，示例：draw_deck；修改后保存并重载js", "工具");
        seal.ext.registerTemplateConfig(ext, "默认关闭的函数", [''], "每行一个默认关闭的函数名，AI 默认无法调用，示例：get_msg", "工具");
        seal.ext.registerTemplateConfig(ext, "可调用指令白名单", ['fun|jrrp', 'story|modu', 'coc7|st', 'coc7|ra', 'coc7|sc'], "每行一个 AI 可调用的海豹指令；格式：扩展名|指令名（指令与插件同名时可只写指令名）。示例：wifeOfTheDay|今日老婆、fun|jrrp、coc7|st。默认包含内置技能所需指令，可自行增删。修改后保存并重载 js", "工具");
        seal.ext.registerBoolConfig(ext, "是否允许调用所有指令", false, "开启后忽略白名单，允许调用所有可解析的指令；默认关闭，建议保持关闭以限制权限", "工具");
        seal.ext.registerTemplateConfig(ext, "提供给AI的牌堆名称", [''], "每行一个牌堆名，示例：克苏鲁的呼唤；没有的话建议把 draw_deck 加入不允许调用", "工具");
        seal.ext.registerTemplateConfig(ext, "MCP服务器配置", [''], "每条配置项一个 MCP 服务器，支持两种格式：\n① 简写：名称|地址|Token\n② 标准 mcpServers JSON：直接粘贴 Claude/Cursor/.mcp.json 里的服务器配置，如 {\"mcpServers\":{\"mcp-files-exec\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:3910\",\"headers\":{\"Authorization\":\"Bearer token\"}}}}，可带任意自定义 headers\n说明：stdio（command）服务器需拉起子进程，海豹环境不支持会自动跳过，请用 Streamable HTTP（type=http + url）；修改后保存并重载js", "工具");
        seal.ext.registerTemplateConfig(ext, "技能配置", [
            "今日人品|查询指定用户的今日人品值|使用 run_command 工具执行：action=call，command=\"fun|jrrp\"，args=[\"用户名或QQ号\"]；fun|jrrp 需在「可调用指令白名单」中",
            "COC模组抽取|随机抽取一个 COC 模组|使用 run_command 工具执行：action=call，command=\"story|modu\"，args=[\"roll\"]；story|modu 需在「可调用指令白名单」中",
            "COC模组搜索|按关键词搜索 COC 模组|使用 run_command 工具执行：action=call，command=\"story|modu\"，args=[\"search\",\"关键词\"]；story|modu 需在「可调用指令白名单」中",
            "属性展示|展示指定玩家的 COC 全部个人属性|使用 run_command 工具执行：action=call，command=\"coc7|st\"，args=[\"show\",\"玩家名称或QQ号\"]；coc7|st 需在「可调用指令白名单」中",
            "属性检定|对指定玩家进行一次属性/技能检定（ra）|使用 run_command 工具执行：action=call，command=\"coc7|ra\"，args 按顺序：奖励/惩罚骰（可选，如 b、p3）、检定表达式（含难度等级或数值运算时直接用，普通属性名时用该属性，属性为0时补50）、检定原因（可选）；coc7|ra 需在「可调用指令白名单」中",
            "san检定|对指定玩家进行 san check（sc）|使用 run_command 工具执行：action=call，command=\"coc7|sc\"，args 按顺序：奖励/惩罚骰（可选，如 b、p2）、表达式（成功时掉san/失败时掉san，如 0/1d6、0/1）；coc7|sc 需在「可调用指令白名单」中"
        ], "每条配置项一个技能，支持三种格式：\n① 旧格式：名称|描述|内容\n② JSON：{\"name\":\"骰点\",\"description\":\"...\",\"content\":\"...\"}\n③ 标准 SKILL.md：直接粘贴其他 agent（Claude/Codex/Cursor）的技能文件，--- 开头的 frontmatter 里写 name/description，正文为技能内容\n默认包含基于 run_command 统一调用的指令技能（今日人品/COC模组/属性展示/检定等），指令需加入「可调用指令白名单」，可自行增删。AI 可通过 use_skill 工具按需调用", "工具");
        seal.ext.registerOptionConfig(ext, "ai语音使用的音色", '傲娇少女', [
            "小新",
            "猴哥",
            "四郎",
            "东北老妹儿",
            "广西大表哥",
            "妲己",
            "霸道总裁",
            "酥心御姐",
            "说书先生",
            "憨憨小弟",
            "憨厚老哥",
            "吕布",
            "元气少女",
            "文艺少女",
            "磁性大叔",
            "邻家小妹",
            "低沉男声",
            "傲娇少女",
            "爹系男友",
            "暖心姐姐",
            "温柔妹妹",
            "书香少女",
            "自定义"
        ], "该功能在选择预设音色时，需要安装 http 依赖插件，且需要可调用 AI 语音 API 的 napcat/lagrange 等。\n选择自定义音色时，则需要 aitts 依赖插件和 ffmpeg", "工具");
    }

    static get() {
        return {
            STATUS: seal.ext.getBoolConfig(ext, "开启调用函数功能"),
            PROMPT_ENGINEERING: seal.ext.getBoolConfig(ext, "切换为提示词工程"),
            BLOCK_REQUIRE_OWNER_CONFIRM: seal.ext.getBoolConfig(ext, "拉黑前需要骰主确认"),
            MAX_CALL_COUNT: seal.ext.getIntConfig(ext, "允许连续调用函数次数"),
            TOOL_RESPONSE_COMPRESS_MIN_LENGTH: seal.ext.getIntConfig(ext, "工具响应压缩触发字数"),
            BLOCKED: seal.ext.getTemplateConfig(ext, "禁止调用的函数"),
            DEFAULT_CLOSED: seal.ext.getTemplateConfig(ext, "默认关闭的函数"),
            CMD_WHITELIST: seal.ext.getTemplateConfig(ext, "可调用指令白名单"),
            ALLOW_ALL_CMDS: seal.ext.getBoolConfig(ext, "是否允许调用所有指令"),
            DECKS: seal.ext.getTemplateConfig(ext, "提供给AI的牌堆名称"),
            TTS_CHARACTER: seal.ext.getOptionConfig(ext, "ai语音使用的音色")
        }
    }
}
