// 版本更新日志（数据文件）：4.23.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 模型类型可手动声明：「模型」页 api连接 新增可选 [types] 表（在本框末尾追加，表内每个模型写一条 "模型名" = "text" / "vision" / "embed"），**优先级最高**，可覆盖命名猜测——网关自命名的嵌入模型不再被误当对话模型、未命中命名白名单的多模态模型也能进识图候选；模型名含 . : / 等字符需加引号，[types] 必须写在本框最后（其后不能再写 api_key 等键），无效值只忽略该键并记日志
- 手动类型声明未命中当前模型列表时（模型名拼写错误 / 已移出清单）记一条 warning 提示，不再静默失效
- 列表接口能力位自动识别：连接拉取模型列表时读取供应商自报的能力位（type / model_type / kind / task、architecture.input_modalities、capabilities、supports_vision），自动区分多模态与嵌入模型（适配 OpenRouter / LM Studio / vLLM / Ollama 风格字段）；只取正向证据（保守元数据不会把模型降级），命名终值白名单（如 text-embedding-*）优先于接口元数据；只返回纯模型名、不自报能力的网关行为完全不变。仍只发一次列表请求，不做任何额外探测
## 配置变更
- 「模型」页 api连接：新增可选 [types] 表（模型名 → text/vision/embed，优先级最高）
- 配置描述统一按「框」表述模板配置的每个文本框：模板配置的每个元素是一个文本框，不再用「行」描述元素（如「每行一个」→「每框一个」；模板解析失败的日志同步改为「第 N 框」）；框内内容自身的「行」表述（如角色设定「第一行为名称」、TOML/JSON 语法行）保持原样

## 命令与工具变更
- .ai tool 新增**工具组**维度：内置工具按能力细分为 14 个分类（基础调度 / 指令 / 定时 / 触发 / 记忆 / 图片 / OB11 / 资源 / 属性 / 原文检索 / 黑名单 / 网页 / 公开会话 / 子代理，外部插件注册的工具归「外部插件」），MCP 工具按服务器成组；.ai tool（无参）改为**组概览**（组名 + 工具数 + 开/关统计，不再刷屏列出 60+ 行），.ai tool <组名> 查看组内明细，.ai tool <函数名> 直接看工具详情，.ai tool all 保留原扁平全量视图
- .ai tool on/off <组名> 支持**整组批量开关**（显式写法 --group=<组名>，可绕开 on/off/help/call/list/all 等保留字与撞名）；**关闭时默认跳过核心常驻工具**（list_tools / search_tools / list_mcps / call_tool / use_skill / call_ob11_api / run_ext_command / run_core_command），避免一键关掉 AI 的工具发现与执行入口——无参 .ai tool off 同样适用，确需全关加 --force；开启时跳过「禁止调用的函数」并如实回报变更/跳过个数
- 技能与知识库不参与工具组维度（其会话开关仍由 .ai skill / .ai kb 管理，单工具开关 .ai tool on/off use_skill 等行为不变）；.ai mcp on/off <服务器> 与 .ai tool on/off <服务器> 等价，两者共用同一批量开关实现
- AI 侧工具发现同步分组口径：list_tools 组头与 search_tools 详情的「来源」改为「内置·记忆」这类两级显示名，list_tools / search_tools 的 mcp= 参数可按分类名（如 记忆、图片、子代理）或 MCP 服务器名过滤，mcp=内置 仍匹配全部内置工具
- 新增「上下文编辑」工具组：context_edit_list（按序号定位任意会话上下文条目，支持 role/keyword/时间过滤）与 context_edit_replace（按 scope 批量替换正文文本，支持字面量/正则、空串删除、原文副本同步与持久化）；目标会话缺省=当前会话，可用 bot_id + session_id 跨会话定位（同一 SealDice 实例内多端点/多账号），敏感工具但默认开启
- .ai standby 支持子参数：.ai standby on 等同原 .ai standby（开启待机）；.ai standby off **仅关闭待机、保留计数器/计时器/概率/活跃时间段/评分等其它触发模式与运行态**（适合「只播报不读群消息」的机器人）；.ai off --sb 等价 standby off
`;
