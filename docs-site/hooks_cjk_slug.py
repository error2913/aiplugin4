"""与 GitHub 完全一致的标题锚点 slugify。

为什么必须自定义
----------------
MkDocs toc 扩展的默认 slugify（`markdown.extensions.toc.slugify`）会剥掉全部
CJK 字符：`## 快速开始` 变成 `_1`，`## 常见问题处理` 变成 `_2`。README.md 正文
里有 53 条 `#中文标题` 目录链接，锚点一变形整个目录就废了。

GitHub 的规则（已用线上渲染结果逐条核对）
------------------------------------------
GitHub 的算法是「删掉不保留的字符，空格转 '-'，然后转小写」，注意它
**不合并连续连字符、也不去掉首尾连字符**，因此：

    ## 🌟 核心特性            -> -核心特性        （emoji 被删，留下一个前导 '-'）
    ## ⚙️ 配置手册            -> ️-配置手册       （emoji 被删，保留变体选择符 U+FE0F）
    ### 1. 下载插件           -> 1-下载插件
    ## MCP 技能 知识库管理命令 -> mcp-技能-知识库管理命令
    ## 🎲 AI骰娘4 - SealDice AI插件 -> -ai骰娘4---sealdice-ai插件

变体选择符 U+FE0F 属于 Mn（非间距标记）类别，GitHub 保留它，所以 `⚙️` 只剩
那个不可见的 U+FE0F。README 的目录链接就是按这个形式写的，必须原样复刻，
否则那几条带 emoji 的锚点会全部失效。

判定用 Unicode 类别而不是字符区间：emoji 区间写窄了会漏、写宽了会把
CJK 标点之外的符号也放进来（实测 `\\w` 与宽 emoji 区间会让 emoji 本体被保留）。
挂载方式见 mkdocs.yml 的 `markdown_extensions -> toc -> slugify`。
注意：本文件**不要**改名成 `slug.py`——那个名字会被 MkDocs 当成内置 slugify 插件加载。
"""

import unicodedata

# 保留的 Unicode 大类：字母(L*)、数字(Nd)、下划线(Pc)、连字符(Pd)、
# 空格(Zs)、以及 CJK 表意文字（Lo 已在 L* 内，此处显式列出以便阅读）。
_KEEP_CATEGORIES = ("L", "Nd", "Pc", "Pd", "Zs")


def _keep(ch: str) -> bool:
    cat = unicodedata.category(ch)
    # Mn：变体选择符 U+FE0F 等非间距标记，GitHub 保留
    if cat == "Mn":
        return True
    return cat.startswith("L") or cat in ("Nd", "Pc", "Pd", "Zs")


def slugify(value, separator="-"):
    """按 GitHub 的标题锚点规则生成 slug。"""
    value = value.strip().lower()
    kept = "".join(ch for ch in value if _keep(ch))
    return kept.replace(" ", separator)
