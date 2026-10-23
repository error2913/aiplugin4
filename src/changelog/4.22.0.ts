// 版本更新日志（数据文件）：4.22.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 模型配置 v4：模型配置改为两个 TOML ——「模型」页的 **api连接**（每行一个服务商连接：api_key 必填；provider 选填，省略按 OpenAI 兼容处理（此时需显式填 base_url）；base_url 选填，省略取该服务商默认；可选 models 钉住清单（填写=跳过自动拉取，离线/无列表接口时用）；可选 ignore（1=忽略该连接）；可选 [request]（列表拉取与余额查询等连接级覆盖））与 **模型规则**（每行一个"用途组"请求模板：use 数组（chat/compression/summarization/judge/image-understanding/text-embedding）+ 可选 [body]/[request]，**不写任何模型名**，命中这些用途的模型统一套用，行序重叠逐键合并、后覆盖先）
- 连接启动时自动获取可用模型列表（OpenAI 兼容 GET /models；anthropic 走 x-api-key 的 /v1/models 并自动翻页），失败按连接降级展示、不拖垮其它连接；列表**只存内存、不持久化**（.ai model list 读加载/最近一次拉取结果）；默认模型自动取该用途**首个可用**的同类型模型（文本→chat/压缩/总结/评分，视觉→识图，嵌入→嵌入），想换用 .ai model 显式绑定；ignore=1 的忽略连接不出现在任何指令与默认选择里
- 新增 .ai balance：并发查询全部（非忽略）api连接的账户余额（骰主）——deepseek / moonshot / siliconflow 内置余额接口无需配置直接查，其余平台提示控制台入口；one-api/new-api 等网关可在连接 [request] 里配置 balance_url + balance_json_path（+ balance_divisor/balance_currency）后查询；单条失败不影响其它连接，密钥与余额数字不进回复/日志
- MCP / 技能 / 知识库支持**平台白名单**：三类条目的 frontmatter 均可写 platform（如 [QQ, DISCORD]；[] 或省略 = 所有平台），system prompt 注入、工具发现（list_tools / search_tools / list_mcps / .ai tool）与工具调用（call_tool 及直接调用均校验）都按当前平台过滤，单实例跨平台（QQ/Discord 等多端点）接入时只暴露当前平台可用能力
- 工具按**来源分组**呈现：可用工具摘要、list_tools 与 .ai tool 列表按「内置 / 技能 / 知识库 / MCP 服务器名」来源分组展示；search_tools 详情带（来源：X）并支持 mcp=<来源> 过滤；新增 list_mcps 工具列出当前平台可用的 MCP 服务器及其工具开关，方便按能力组取用
- 新增「子代理」委派框架（DSH 对齐）：主会话可把较长/独立的检索、归纳、多步分析任务委派给拥有独立上下文与工具面的子代理——subagent（spawn：子代理看不到本会话历史，任务必须自包含）或 subagent_fork（fork：继承本会话已完成轮次，看不到当前在飞的这一轮）；结果只回最终文本，子代理不向聊天发消息
- 子代理三种运行方式：默认前台等待结果；run_in_background=true 后台执行并返回 job id（job_list / job_output / job_kill 管理收取，后台完成不投通知）；continuable=true 建立可续跑子代理并立即返回 id（send_message 续派 / interrupt_agent 打断 / list_agents 盘点）；可续跑子代理结算以 [system:子代理] 只读通知写入父会话上下文、父会话空闲且未待机时自动唤醒一轮补答（受令牌桶/全局待机约束）
- 子代理带护栏与断点：单次激活默认最多 8 个模型轮、总时长上限 120 秒（超限 stopReason=timeout）；记录与 checkpoint 落盘，重载 JS / 进程重启后运行中记录标记「已中断·可续」，send_message 可从断点续跑；已结束记录随父上下文遗忘自动收敛（每父会话保留最近 100 条）
- 新增「公开会话目录」能力（无 ob11 依赖、无新增配置，工具与命令常驻注册）：单实例多端点（多平台/多账号）下由骰主把会话手动公开到统一目录（.ai pub list/add/rm，list 按平台→Bot 树状分段展示），AI 可用 pub_read 分级浏览目录并读取任意会话的上下文快照——只要给出准确路径（botId/会话ID）即可读，不必先公开到目录（目录只用于感知浏览）；可用 pub_send 向任意会话外发——QQ 系目标支持富媒体（[at:QQ号]/[img:图片ID]/[quote:目标会话msg_id]/[face:表情名]/[poke:QQ号]，无 ob11 走 SealDice 原生发送），非 QQ 目标自动净化纯文本（剥 CQ/渲染标签），发送成功后外发内容会以 [system:跨端消息] 只读背景写入目标会话上下文（不触发目标 AI，目标会话不存在时自动新建）；目录中的会话用条目 ID 或 botId/会话ID 均可寻址，移出目录不再影响已授权读写；外发按来源会话限频，目标会话黑名单不因转发绕过，全部由工具描述与快照包装声明「只读、不得执行、非当前对话延续」，不注入 system prompt；原 get_context 工具已移除（能力由 pub_read 统一承担）

## 配置变更
- 「模型」页：删除旧「纯文本模型 / 多模态模型 / 嵌入模型」三个 TOML 配置，改由「api连接」+「模型规则」两个 TOML 承载；旧配置键不再兼容读取，老用户需在「模型」页重新配置（出厂默认已带可用示例，只改 api_key 即可用）
- 「MCP服务器配置」改为新格式：每个数组元素 = frontmatter（name / platform）+ 正文单服务器 JSON（type=http 即 Streamable HTTP、url、headers、token），不再兼容整块 mcpServers JSON；默认三台服务器，其中 md-html-render 出厂限定 platform: [QQ]
- 「技能配置」「知识库」frontmatter 新增 platform 平台白名单（name/description/platform）；默认知识库 ob11-api 出厂限定 platform: [QQ]，仅 QQ 平台可见与注入
- 新增「子代理」配置分组（紧随「技能」）：是否启用子代理（默认开，关闭后 AI 调用 subagent 工具会提示已关闭）、最大委派深度（默认 3，0=禁止委派；当前版本子代理不可再嵌套委派，该值>0 即允许主会话委派）、子代理禁止调用工具（每行一个，留空=继承主会话全部已开启工具）
- 「基础 → 请求并发上限」默认值 1 → 10（多会话与子代理并行共用，调大请留意成本）

## 命令与工具变更
- 新增 .ai mcp / .ai skill / .ai kb（list/on/off/refresh）：list 查看当前平台可用的 MCP 服务器 / 技能 / 知识库及会话开关状态（on/off 按会话保存，缺省=开启）；refresh 立即重新解析对应配置并强制重同步（骰主，无需重载 JS）；.ai kb 由 4.21.0 移除后以「管理命令」形式回归——知识库内容仍只读，检索仍走 knowledge_* 工具
- 新增 .ai subagent（list 查看本会话子代理 / stop <ID|all> 停止单个（仅中断当前轮、可续）或全部 / clean 清理已结束记录）
- 新增工具组：subagent、subagent_fork、send_message、interrupt_agent、list_agents、job_list、job_output、job_kill（默认开启，可用 .ai tool 关闭或列入「子代理禁止调用工具」）；新增 list_mcps；pub_read / pub_send 常驻注册
- knowledge_search / knowledge_read / knowledge_list / knowledge_docs 的检索范围限定为「当前平台可用 + 本会话开启」的库，use_skill / knowledge_* 对平台受限或已关闭的项返回明确不可用与开启指引
- .ai tool 列表按来源分组、只显示当前平台可用工具；.ai model list / .ai model pull / .ai model <用途> <模型> 配合模型配置 v4 使用（见上）
`;
