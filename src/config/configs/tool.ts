// 工具配置：函数调用开关/提示词工程/上限/禁用与默认关闭
import { ext } from "../config";
export default class ToolConfig {
    static register() {

        seal.ext.registerBoolConfig(ext, "开启调用函数功能", true, "总开关；关闭后 AI 无法调用任何工具，仅保留普通对话", "工具");
        seal.ext.registerBoolConfig(ext, "切换为提示词工程", false, "API在不支持function calling功能的时候开启", "工具");
        seal.ext.registerBoolConfig(ext, "拉黑前需要骰主确认", true, "AI 建议拉黑时需骰主确认后才生效；关闭后 AI 可直接拉黑", "工具");
        seal.ext.registerIntConfig(ext, "允许连续调用函数次数", 10, "单次回复流程中允许连续调用工具的次数，防止无限循环；0 为不限制", "工具");
        seal.ext.registerIntConfig(ext, "工具响应压缩触发字数", 5000, "工具返回结果超过该字数时压缩后再存入上下文；设为 0 不压缩", "工具");
        seal.ext.registerTemplateConfig(ext, "禁止调用的函数", [''], "每行一个禁止 AI 调用的函数名，示例：draw_deck；修改后自动生效", "工具");
        seal.ext.registerTemplateConfig(ext, "默认关闭的函数", [''], "每行一个默认关闭的函数名，AI 默认无法调用，示例：get_msg；修改后自动生效", "工具");
        seal.ext.registerTemplateConfig(ext, "可调用指令白名单", ['fun|jrrp', 'story|modu', 'coc7|st', 'coc7|ra', 'coc7|sc'], "每行一个 AI 可调用的海豹指令；格式：扩展名|指令名，核心指令的扩展名统一写 core（如 core|ext）。run_core_command 的 core|ext 无需加入白名单。修改后自动生效", "工具");
        seal.ext.registerBoolConfig(ext, "是否允许调用所有指令", false, "开启后忽略白名单，允许调用所有可解析的扩展指令；核心指令仍通过 run_core_command 调用", "工具");
        seal.ext.registerStringConfig(ext, "指令前缀", ".", "注入到 SealDice 核心的指令前缀，通常为 .；如果核心改成其他前缀，请同步修改", "工具");
        seal.ext.registerTemplateConfig(ext, "提供给AI的牌堆名称", [''], "每行一个牌堆名，示例：克苏鲁的呼唤；没有的话建议把 draw_deck 加入不允许调用", "工具");
        seal.ext.registerBoolConfig(ext, "是否启用MCP", false, "MCP 功能总开关；默认关闭，避免未安装 MCP 后端时启动或对话报错。开启后才会解析下方「MCP服务器配置」并连接/注册 MCP 工具", "工具");
        seal.ext.registerTemplateConfig(ext, "MCP服务器配置", [
            `{
  "mcpServers": {
    "mcp-files-exec": {
      "type": "http",
      "url": "http://127.0.0.1:3910/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    },
    "web-read": {
      "type": "http",
      "url": "http://127.0.0.1:46799/mcp",
      "tools": {
        "screenshot_url": {
          "hidden": true
        },
        "scrape_url": {
          "exposeAs": "web_read",
          "adapter": "web_read",
          "remoteTools": {
            "screenshot": "screenshot_url",
            "scrape": "scrape_url"
          },
          "description": "读取网页内容或对网页截图。默认抓取网页标题/正文/链接；screenshot=true 时对网页截图并返回可发送的图片",
          "parameters": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "description": "需要读取内容或截图的网页链接"
              },
              "screenshot": {
                "type": "boolean",
                "description": "true 时对网页截图并返回图片，false（默认）时抓取网页文本内容"
              },
              "width": {
                "type": "integer",
                "description": "截图视口宽度，默认 1680"
              },
              "height": {
                "type": "integer",
                "description": "截图视口高度，默认 1000"
              },
              "fullPage": {
                "type": "boolean",
                "description": "是否截取整页（长图），默认 false"
              },
              "delay": {
                "type": "integer",
                "description": "页面加载完成后等待的毫秒数，默认 3000"
              }
            },
            "required": ["url"]
          }
        }
      }
    },
    "md-html-render": {
      "type": "http",
      "url": "http://127.0.0.1:37632/mcp",
      "tools": {
        "render_markdown": {
          "exposeAs": "render_markdown",
          "adapter": "render_markdown",
          "output": "image",
          "format": "unknown",
          "description": "渲染 Markdown 内容为图片",
          "parameters": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "description": "要渲染的 Markdown 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。可以使用[img:xxxxxx]替代图片url（注意使用markdown语法显示图片），xxxxxx为图片id，或avatar:用户名称/ID，或group_avatar:群聊名称/ID"
              },
              "name": {
                "type": "string",
                "description": "名称，对内容大致描述"
              },
              "theme": {
                "type": "string",
                "enum": ["light", "dark", "gradient"],
                "description": "主题样式，其中 gradient 为紫色渐变背景"
              },
              "save": {
                "type": "boolean",
                "description": "是否保存图片"
              }
            },
            "required": ["content", "name", "save"]
          }
        },
        "render_html": {
          "exposeAs": "render_html",
          "adapter": "render_html",
          "output": "image",
          "format": "unknown",
          "description": "渲染 HTML 内容为图片",
          "parameters": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string",
                "description": "要渲染的 HTML 内容。支持 LaTeX 数学公式，使用前后 $ 包裹行内公式，前后 $$ 包裹块级公式。可以使用[img:xxxxxx]替代图片url（注意使用html元素显示图片），xxxxxx为图片id，或avatar:用户名称/ID，或group_avatar:群聊名称/ID"
              },
              "name": {
                "type": "string",
                "description": "名称，对内容大致描述"
              },
              "save": {
                "type": "boolean",
                "description": "是否保存图片"
              }
            },
            "required": ["content", "name", "save"]
          }
        }
      }
    },
    "ob11-core-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:46880/mcp",
      "tools": {
        "run_core_command": {
          "adapter": "core_bridge_core",
          "sensitive": true,
          "description": "通过核心桥向 SealDice 注入一条假消息并执行核心指令。白名单中的核心扩展名统一写作 core|指令名；核心 .ext 是扩展发现入口，不需要加入白名单，调用 command=\"ext\" 即可查看核心当前全部扩展名称。默认指令前缀为 .，可在配置中修改。",
          "parameters": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string",
                "enum": ["list", "call"],
                "description": "list=列出白名单核心指令；call=执行核心指令"
              },
              "command": {
                "type": "string",
                "description": "核心指令名，如 ext、help；也支持 core|ext"
              },
              "args": {
                "type": "array",
                "items": { "type": "string" },
                "description": "指令参数，按顺序填写"
              },
              "forward": {
                "type": "boolean",
                "description": "是否把捕获到的核心发送消息继续转发给协议端，默认 false（避免重复发送）"
              },
              "captureMode": {
                "type": "string",
                "enum": ["reply_only", "lane"],
                "description": "消息捕获范围；forward=true 且希望捕获协议端回复时建议使用 lane"
              },
              "maxMessages": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50,
                "description": "最多收集多少条消息"
              },
              "settleMs": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10000,
                "description": "收到消息后等待多久没有新消息才结束"
              },
              "timeoutMs": {
                "type": "integer",
                "minimum": 100,
                "maximum": 120000,
                "description": "最长等待时间，单位毫秒"
              }
            },
            "required": ["action"]
          }
        }
      }
    }
  }
}`
        ], "仅支持标准 mcpServers JSON 格式：{\"mcpServers\":{\"服务器名\":{\"type\":\"http\",\"url\":\"...\",\"headers\":{...}}}}（Claude Desktop/Cursor/.mcp.json 可直接粘贴），一个块可包含多个服务器。默认包含四个：mcp-files-exec（文件执行）、web-read（网页读取）、md-html-render（Markdown/HTML 渲染）、ob11-core-bridge（SealDice 核心指令中转）。字段：type（仅支持 http，即 Streamable HTTP）、url（服务器地址）、headers（任意自定义请求头，如 Authorization）、token（自动生成 Bearer 头，与 headers 二选一）、tools（可选工具适配块：键为远端工具名，值为对象，支持 hidden=仅作底层工具不暴露给 AI、exposeAs=暴露给 AI 的工具名、adapter=适配器（text/image/web_read/render_markdown/render_html/core_bridge_core）、description/parameters=覆盖 AI 可见的描述与参数、output/format=图片输出与保存格式、remoteTool/remoteTools=实际调用的远端工具名映射、sensitive=敏感工具标记；未配置 tools 的服务器默认直接用远端工具名注册，与本地/已有工具同名时跳过，可用 exposeAs 改名或 hidden 隐藏）。默认配置直接使用后端提供的工具名：mcp-files-exec 提供 run_shell，ob11-core-bridge 仅提供 run_core_command。格式定义见 https://modelcontextprotocol.io/specification/latest （MCP 官方规范，国内可访问）。说明：stdio（command）服务器需拉起子进程，海豹环境不支持会自动跳过，请用 Streamable HTTP（type=http + url）。修改后自动生效（缓存最多 1 分钟）", "工具");
        seal.ext.registerTemplateConfig(ext, "技能配置", [
            `---
name: 今日人品
description: 查询指定用户的今日人品值
---
使用 run_ext_command 工具执行：action=call，command="fun|jrrp"，args=["用户名或QQ号"]；fun|jrrp 需在「可调用指令白名单」中`,
            `---
name: COC模组抽取
description: 随机抽取一个 COC 模组
---
使用 run_ext_command 工具执行：action=call，command="story|modu"，args=["roll"]；story|modu 需在「可调用指令白名单」中`,
            `---
name: COC模组搜索
description: 按关键词搜索 COC 模组
---
使用 run_ext_command 工具执行：action=call，command="story|modu"，args=["search","关键词"]；story|modu 需在「可调用指令白名单」中`,
            `---
name: 属性展示
description: 展示指定玩家的 COC 全部个人属性
---
使用 run_ext_command 工具执行：action=call，command="coc7|st"，args=["show","玩家名称或QQ号"]；coc7|st 需在「可调用指令白名单」中`,
            `---
name: 属性检定
description: 对指定玩家进行一次属性/技能检定（ra）
---
使用 run_ext_command 工具执行：action=call，command="coc7|ra"，args 按顺序：奖励/惩罚骰（可选，如 b、p3）、检定表达式（含难度等级或数值运算时直接用，普通属性名时用该属性，属性为0时补50）、检定原因（可选）；coc7|ra 需在「可调用指令白名单」中`,
            `---
name: san检定
description: 对指定玩家进行 san check（sc）
---
使用 run_ext_command 工具执行：action=call，command="coc7|sc"，args 按顺序：奖励/惩罚骰（可选，如 b、p2）、表达式（成功时掉san/失败时掉san，如 0/1d6、0/1）；coc7|sc 需在「可调用指令白名单」中`
        ], "每条配置项一个技能，仅支持标准 SKILL.md 格式：以 --- 开头的 YAML frontmatter 里写 name（必填）/description（可选），正文为技能内容；可直接粘贴其他 agent（Claude/Codex/Cursor）的技能文件。\n格式定义见 https://agentskills.io/specification （SKILL.md 开放规范，Claude/Codex 通用，国内可访问）。\n默认包含基于 run_ext_command 统一调用的扩展技能（今日人品/COC模组/属性展示/检定等），指令需加入「可调用指令白名单」，可自行增删。修改后自动生效（缓存最多 1 分钟）。AI 可通过 use_skill 工具按需调用", "工具");
        seal.ext.registerTemplateConfig(ext, "音乐服务配置", [
            `{
  "platform": "网易云",
  "api": "http://net.ease.music.lovesealdice.online",
  "cookie": "_gid=GA1.2.2048499931.1737983161; _ga_MD3K4WETFE=GS1.1.1737983160.8.1.1737983827.0.0.0; _ga=GA1.1.1845263601.1736600307; MUSIC_U=00C10F470166570C36209E7E3E3649FEE210D3DB5B3C39C25214CFE5678DCC5773C63978903CEBA7BF4292B97ADADB566D96A055DCFDC860847761109F8986373FEC32BE2AFBF3DCFF015894EC61602562BF9D16AD12D76CED169C5052A470677A8D59F7B7D16D9FDE2A4ED237DE5C6956C0ED5F7A9EA151C3FA7367B0C6269FF7A74E6626B4D7F920D524718347659394CBB0DAE362991418070195FEFC730BCCE3CF4B03F24274075679FB4BFC884D099BD3CF679E4F1C9D5CBC2959CD29B0741BD52BCA155480116CE96393663B1A51D88AFDB57680F030CF93A305064A797B99874CA826D6760F616CB756B680591167AEE9AF31C4A187E61A19D7C1175961D4FE64CFD878F0BCEBB322A23E396DC5E8175A50D5E07B9788E4EBE8F8257FF139DB4FD03A89676F5C3DF1B70C101F4568C0A3657C24185218F975368ADB2DEF860760C59E9AFCCB214A4B51029E29ED; __csrf=85f3aa8cedc01f6d50b6b924efbf6f95; NMTID=00OG17oToz2Ne1rikTtgKPqOLaYuP0AAAGUqBEN0A"
}`,
            `{
  "platform": "qq",
  "api": "http://qqmusic.lovesealdice.online",
  "cookie": ""
}`
        ], "每行一条音乐服务配置，仅支持 JSON 格式：{\"platform\":\"网易云\",\"api\":\"域名\",\"cookie\":\"Cookie（可留空，网易云部分接口需要）\"}。platform 支持：网易云、qq。修改后自动生效（缓存最多 1 分钟）", "工具");
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
        ], "该功能在选择预设音色时，需要安装 http 依赖插件，且需要可调用 AI 语音 API 的 napcat/lagrange 等。\n选择自定义音色时，则需要生成音频依赖（tts）和 ffmpeg", "工具");
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
            COMMAND_PREFIX: seal.ext.getStringConfig(ext, "指令前缀"),
            DECKS: seal.ext.getTemplateConfig(ext, "提供给AI的牌堆名称"),
            MCP_ENABLED: seal.ext.getBoolConfig(ext, "是否启用MCP"),
            TTS_CHARACTER: seal.ext.getOptionConfig(ext, "ai语音使用的音色"),
            MUSIC: seal.ext.getTemplateConfig(ext, "音乐服务配置")
        }
    }
}
