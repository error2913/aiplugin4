"""对照 GitHub 线上锚点，逐个核对 slugify 是否一致。

GitHub 侧的真值来自 https://github.com/error2913/aiplugin4/blob/main/README.md
渲染出的 id="user-content-XXX"（本文件 EXPECTED 即取自该页面）。
"""

import hooks_cjk_slug as h

# 从 GitHub 渲染页抓下来的真值（去掉 user-content- 前缀）
EXPECTED = {
    "🌟 核心特性": "-核心特性",
    "⚙️ 配置手册": "\ufe0f-配置手册",
    "🛠️ 完整安装指南": "\ufe0f-完整安装指南",
    "🚨 注意事项": "-注意事项",
    "📞 技术支持": "-技术支持",
    "💻 完整命令手册": "-完整命令手册",
    "🧰 可用工具函数": "-可用工具函数",
    "🎲 AI骰娘4 - SealDice AI插件": "-ai骰娘4---sealdice-ai插件",
    "快速开始": "快速开始",
    "目录": "目录",
    "常见问题处理": "常见问题处理",
    "1. 下载插件": "1-下载插件",
    "2. 安装插件": "2-安装插件",
    "3. 配置大模型": "3-配置大模型",
    "MCP": "mcp",
    "MCP 技能 知识库管理命令": "mcp-技能-知识库管理命令",
    "prompt 模板": "prompt-模板",
    "token 计数命令": "token-计数命令",
    "环境要求": "环境要求",
    "下载": "下载",
    "依赖下载": "依赖下载",
    "安装": "安装",
    "模型": "模型",
    "基础": "基础",
    "错误处理": "错误处理",
    "角色设定": "角色设定",
    "上下文": "上下文",
    "消息接收": "消息接收",
    "事件接收": "事件接收",
    "消息触发": "消息触发",
    "图片": "图片",
    "工具": "工具",
    "技能": "技能",
    "子代理": "子代理",
    "记忆": "记忆",
    "知识库": "知识库",
    "回复": "回复",
    "后端": "后端",
    "公开会话": "公开会话",
    "资源": "资源",
    "管理员命令": "管理员命令",
    "基础控制命令": "基础控制命令",
    "记忆管理命令": "记忆管理命令",
    "工具管理命令": "工具管理命令",
    "忽略名单相关命令": "忽略名单相关命令",
    "图片相关命令": "图片相关命令",
    "定时器相关命令": "定时器相关命令",
    "公开会话目录命令": "公开会话目录命令",
    "版权信息": "版权信息",
    "致谢": "致谢",
}


def main():
    bad = []
    for title, want in EXPECTED.items():
        got = h.slugify(title)
        if got != want:
            bad.append((title, want, got))

    total = len(EXPECTED)
    if bad:
        print(f"不一致 {len(bad)}/{total}：")
        for title, want, got in bad:
            print(
                "  {!r}\n    期望 {}\n    实际 {}".format(
                    title,
                    want.encode("unicode_escape").decode("ascii"),
                    got.encode("unicode_escape").decode("ascii"),
                )
            )
        raise SystemExit(1)

    print(f"全部 {total} 条锚点与 GitHub 一致")


main()
