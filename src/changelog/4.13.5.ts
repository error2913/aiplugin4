// 版本更新日志（数据文件）：4.13.5。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 接收卡片/视频/音乐/文件/语音/合并转发消息：订阅 ob11 网络连接依赖事件分发，把核心 milky 原生路径过滤掉的段接入非指令管线（黑名单/忽略/触发/待机全部生效），合并转发自动展开为可读文本，过长走既有压缩
- 多模态模型支持：图片模型配置 use=chat 后可直接当对话模型用（.ai model 选择），上下文中的图片以 image_url 内容直接传给模型，不再转成文本标签；URL 图片自动转 base64（失败保留原 URL），兼容 anthropic 视觉模型
- 技能配置兼容标准 SKILL.md：可直接粘贴 Claude/Codex/Cursor 的技能文件，frontmatter 的 name/description 自动解析为技能名与摘要
- MCP 服务器配置兼容 mcpServers JSON：可直接粘贴 Claude Desktop/Cursor/.mcp.json 的服务器配置，支持自定义 headers 与 token 简写；stdio/SSE 服务器明确提示后跳过
- web_read / render_markdown / render_html 后端改为 MCP 调用（后端 /mcp 端点）
## 修复
- 修复 ob11 事件消息数组被 seal.Message.message 字符串绑定强转导致无法展开的问题（改为显式传段数组）
- 修复 get_forward_msg 响应字段读取错误（data.messages → data.message），兼容平铺与 node 两种返回形态，file 段字段兼容 milky/NapCat 差异
## 文档
- 新增 docs/10-TODO.md：MCP Streamable HTTP 环境适配后的改动清单
## 优化
- 音乐服务配置化：网易云/qq 的域名与 Cookie 移入「工具-音乐服务配置」（平台|域名|Cookie），不再硬编码
- 新增 OB11 核心指令中转：run_ext_command/run_core_command 通过 MCP Streamable HTTP 调用中间件，由中间件向 SealDice 注入假消息；旧版控制 WS 兼容保留，按群/私聊 lane 串行化并收集多条响应，支持捕获后拦截或继续转发
- 指令监听升级为多消息收集器：使用空闲窗口、最大消息数与超时结束，降低并发调用时的消息混淆
- 内置扩展名单改为代码常量；核心扩展名统一为 core，core|ext 无需白名单即可查看所有扩展
- 模型选取确定性：对话/图片/嵌入模型匹配不再随机抽取，固定取第一个符合用途的模型
- ob11 网络连接依赖订阅等待窗口延长（10 次×3s → 20 次×5s），兼容慢加载环境
- 用量统计过期归并修正：先收集过期 key 统一归并后再替换，避免遍历同一对象时增删丢数据；0-0-0 长期桶不再参与归并
- 消息渲染标签改为方括号格式（如 [at:名称]、[img:图片ID]、[avatar:用户]、[group_avatar:群聊]、[quote:消息ID]、[face:表情]、[audio:音频ID]），提示词模板同步更新；解析层兼容历史 <|...|> 标签（自动归一化），旧模板未更新也能正常收发
## 修复
- 修复提示词工程模式下非流式回复未剥离 <function> 调用块：发送前先截断标签块，标签原文不再进入发送内容与上下文，调用内容仍按原样记录
- 修复 web_search 分页计算错误：page 为 0/负数/非法值时按第 1 页处理，前后半页映射修正
- 清理死代码：删除未使用的 callChat、parseBody、buildRequestMessages、Session.getMessages 等旧实现`;
