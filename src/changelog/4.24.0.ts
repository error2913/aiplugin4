// 版本更新日志（数据文件）：4.24.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 语音合成与文生图**内置到主插件**：「模型」页的 api连接 + 模型规则新增 **tts**（语音合成）与 **image-generation**（文生图）两个用途，不再依赖外部插件——「生成音频（tts）」「生成图片（tti）」依赖插件已废弃（完整包不再附带三个依赖，只保留 ob11 网络连接），\`globalThis.tts\` / \`globalThis.tti\` / \`globalThis.aiDrawing\` 的读取与兜底全部移除
- 模型规则新增四个字段：**models**（按模型定向：只对这些模型生效，优先级高于 use）、**[params]**（声明 AI 可覆写参数的元信息：default/min/max/enum/type/desc）、**[prompt]**（extra 写一段自由提示词，原样注入给 AI）、**[response]**（data_path / data_type / error_message_path / task_id_path / task_status_path / success_values / failure_values / poll_url / poll_interval / poll_max，用于从返回里取音频或图片，支持异步任务轮询）
- **自定义参数在「模型规则」的 [body] 里书写**：用 {占位符} 标出可被 AI/命令覆写的字段，用 TOML 嵌套表表达各供应商真实的字段结构（阿里 \`[body.input.parameters] rate = "{rate}"\`、Google \`[body.audioConfig] speakingRate = "{rate}"\`）——同一个"语速"落到完全不同的字段，供应商差异全部由配置表达、代码零分支；内置占位符：{text} / {prompt} / {negative_prompt} / {image} / {image_url} / {image_base64} / {model} / {api_key}
- 取值优先级：**AI/命令传参 > [params].default > 无值且无默认时整个键不发送**——模型不支持的参数不会进入请求体（未在模板里出现的键一律忽略、不报错），声明了但没值的字段不会以空值污染请求；整值占位符保留原始类型（number 仍是 number），嵌套表内键全被删时自动剪枝（不发送 "parameters": {}）
- **生成改为异步任务**：generate_audio / text_to_image 提交后**立即返回任务号**，不再阻塞（工具层 180s 超时不再会截断慢出图，HTTP 超时改由该模型规则 [request].timeout 控制）；完成后按来源分流——AI 调工具发起的先写入会话通知（入队与唤醒分离，通知不会因唤醒失败而丢），再**唤醒 AI** 起一轮投递，且该送达**免触发令牌桶**（桶空也送达）；会话忙时不起新对话，改由本轮下一次模型请求前的 flushNotices 注入（任务完成得早就在同一条回复里发出，不必另起一轮）；待机/端点离线时通知保留，下一轮对话呈现。人类敲命令发起的由插件**直接投递**（图片走 Image.CQCode 真实文件/URL，不用插件内部 imageId）
- 工具描述与参数 schema **由「模型规则」生成**（逐模型参数清单 + 默认值/范围/枚举 + [prompt].extra），不是硬编码超集：只配一个模型时 schema 就是该模型的精确参数，配多个时标注"仅某模型支持"；修改模型规则需重载 JS 刷新
- 参数校验：类型能安全强转就转（"1.5" → 1.5），无法强转报可读错误；min/max 越界、enum 非法在**提交前**即拒绝，不会建任务；emotion 在模板未声明 emotion 时归一到 instruction
- [types] 可声明类型扩展为 text / vision / embed / **gen**（生图）/ **tts**（语音）；gen 由"内部排除值"改为生图用途的正常标签，语音/生图命名白名单同步扩充（cosyvoice / fish-speech / speech-* / tts-* / chattts / sovits 等），且**语音必须先于 vision 命名能力位判定**（否则 gpt-4o-mini-tts 会被误判为视觉模型）
- 媒体返回支持**非 JSON 响应**：按 [response].data_type 决定取数方式（有 data_path 走 JSON；base64/hex 且无 data_path 表示整个响应体即数据，如 TTS 音频流，并按 content-type 自适应，避免把 JSON 当二进制读）；hex 返回自动转 base64

## 配置变更
- **「工具」页删除「ai语音使用的音色」下拉**：该下拉服务的是**协议端自带的 AI 语音**（NapCat/Lagrange 的 AI 语音 API），与插件 TTS 无关——协议端这条链路骰主本就无需配置模型，AI 现在可直接用 \`call_ob11_api\` 调 \`get_ai_characters\`（查角色）/ \`send_group_ai_record\`、\`send_private_ai_record\`（发送）/ \`get_ai_record\`（只取语音 URL），用法与常见角色名已写进默认知识库 ob11-api。下拉里的「自定义」选项对应的才是插件 TTS 链路，现已内置：自建 TTS（阿里 CosyVoice / 硅基流动 / OpenAI 等）的音色在「模型规则」\`tts\` 用途的 \`[params].voice\`（配合 \`[body]\` 的 \`{voice}\` 占位符）里配置，AI/命令也能按次传 \`voice\`
- 「工具」页新增**媒体任务并发上限**（默认 3）：同时进行的语音/图片生成任务数上限，超出的任务排队等待，避免一次提交过多把接口打满
- 「工具」页新增**媒体生成同步等待秒数**（默认 5）：调用生图/语音工具后先等待这么多秒看是否已出结果，期间生成完就当场把结果返回给 AI、不再走异步通知；超时未完成则正常返回任务号、生成完再通知唤醒。填 0 关闭等待（一律走异步）
- 「模型」页 api连接 / 模型规则 的配置说明同步补充 tts / image-generation 用途与 [params]/[prompt]/[response]/models 字段说明；模型规则出厂模板新增语音（阿里云 CosyVoice）与生图（OpenAI gpt-image-1）两框完整示例
- api连接 [types] 现可声明 gen / tts；无 /models 列表接口的语音/生图服务（Google Cloud TTS 等）用 models 钉住自定名 + [types] 声明即可接入

## 命令与工具变更
- 新增 **.ai tts <文本>**：合成语音并发送，支持 --model / --voice / --rate / --pitch / --volume / --instruction / --emotion；提交后立即回话，完成后由插件直接投递到本会话
- 新增 **.ai tti <描述>**：生成图片并发送，支持 --model / --size / --steps / --seed / --quality / --style / --negative / --save / --name；同上直接投递，--save 会在完成时写入记忆
- 新增 **.ai media**：查看本会话生成任务队列（默认未完成 + 最近 10 条已结束；\`.ai media list [页码] [--all]\` 分页/查看全部；\`.ai media cancel <任务号>\` 取消未完成的任务）；别名 .ai md
- 新增 **media_tasks** 工具（list / cancel）：AI 查看或取消本会话的生成任务队列，归入新增的「多媒体」内置分类
- generate_audio 改为提交任务并立即返回（传 path 时仍**同步**解析本地/MCP 音频资源，不排队）；text_to_image 同样改为提交任务，save / name 意图在完成时写回记忆（异步完成后用 epId/sid 重建 ctx）
- 队列只在存储里放句柄/短摘要（本地文件路径、图片 ID、URL），**绝不落盘 base64**；每会话最多保留 50 条已结束任务，未结束任务永不淘汰；进程重启后 running 任务标记「插件重载中断」并补通知
- 媒体请求**不计入用量统计与 token 校准**（媒体响应里的 usage 与对话 token 语义无关）
- \`.ai model\` 的用途列表与 \`[types]\` 提示同步加入 tts / image-generation 与 gen / tts

## 修复
- 修复**生成响应过快时唤醒丢失、永久等待**：工具来源的媒体任务完成后会无条件 \`session.chat()\` 起一轮投递，而 \`Agent.run()\`/\`runStream()\` 开头有一道同会话闸门 \`if (running || starting) return\` —— 那是**静默 return**（不抛错、不排队、不打日志），且媒体唤醒是唯一绕开消息管线分流、直接调 \`chat()\` 的调用方（普通消息已由 \`deferReceipt\` 挂起，撞不到它）。于是生成极快时（本地模型/缓存命中/极短文本）：通知入队 → \`chat()\` 撞闸门被静默丢弃（Promise 正常 resolve、\`.catch\` 不触发、日志还写着"触发成功"）→ 若本轮已过最后一次模型请求，\`flushNotices\` 不会再消费它 → **结果永远送不出去**；更糟的是入队时就把 \`notified\` 置了 true（谎报成功），把"重载补发"这条兜底也一并堵死。现改为三段式：① **提交后同步等待窗口**（「工具 → 媒体生成同步等待秒数」，默认 5 秒）——窗口内出结果就**当场返回**（图片直接给 \`[img:ID]\`、语音给 record 段指引），根本不进唤醒链路；② 窗口内没完成则入队（带 \`taskId\`）、**空闲才唤醒**，会话忙则 defer 且通知留在队列；③ **轮末补触发**——\`Agent.run()\`/\`runStream()\` 的 \`finally\` 中（\`resumePending\` 之后、\`starting\` 归零之后）调用 \`MediaTaskManager.wakePendingNotices()\`，由"会话真的结束了"这一确定事件驱动，把仍未被消费的媒体通知补起一轮。补触发起的这一轮结束时再检查，届时通知已被消费 → 自动停止，**不会死循环**；\`notified\` 改由 \`flushNotices\` 真正消费时回置（\`markNotifiedByNotice\`），重载补发因此恢复有效
- 媒体结果通知新增 \`taskId\` 身份标识（\`noticeQueue\`），用于判断"该通知是否已被本会话消费"，避免重复唤醒
- 修复**一条 QQ 图床死链卡死整个会话**：图片 URL 转 base64 失败后仍会原样作为 image_url 交给模型，模型侧下载失败（QQ 直链 rkey 过期 → 400）会让整轮请求报 invalid_request，而该类别不在报错自动处理范围 → 静默不回复；更麻烦的是这条坏消息已持久化进上下文，此后每轮组包都会重复 400（表现为「卡住」）。现在三处兜底：① 后端回包里出现上游 4xx（\`400 Client Error\`、QQ 的 \`download url has expired\`）即判定 URL 已不可用，不再走 1 小时冷却 × 3 次的无意义重试；② 请求组装时，已确认不可用或 QQ 临时直链（multimedia.nt.qq.com.cn / gchat.qpic.cn / c2cpic\*.qpic.cn / 带 rkey 的链接）转换失败的图片只保留 \`[img:id]\` 文本标签，不再产生 image_url 内容块；③ 模型报 \`Failed to download image\` 时自动把这些图片标记为不可用并降级重发一次（旧上下文里的死链图片也一并自动清理），不再静默卡住
- 识图请求遇到已确认不可用的 URL 直接跳过，不再白花一次视觉模型请求
- 修复**取消正在生成的媒体任务不生效**：\`.ai media cancel\` / \`media_tasks action=cancel\` 取消运行中的任务后，结果落地仍会把状态覆盖回「已完成」并照常投递（命令侧直接发到群里）——现在落地与失败两条路径都会先检查取消状态，已取消的任务丢弃结果、不写记忆、不投递
- 修复**上下文编辑可能写入可发送标签**：\`context_edit_replace\` 的替换文本原先用 \`stripInternalTags\` 清洗，而该函数按设计**保留** \`[at:…]\` / \`[img:…]\` / \`[record:…]\` 等可发送标签，被写入并持久化后经回复管线渲染即成为真实发送指令（等价于让被污染的上下文获得「@全体成员 / 发外链图」能力，且反复生效）；现改用用户输入口径的 \`stripUserTags\`，可发送标签转义为字面量、伪造闭合标签整段删除
- 修复**上下文编辑可凭空创建会话**：\`getSession()\` 对任意未知 sessionId 都会新建会话，原先对不存在的目标会话（如群里随手写的 \`QQ-Group:999999\`）也会照常写入并落盘；现在写入前先确认目标会话在存储中确有存档，否则拒绝并给出可读提示
- 修复**上下文编辑的参数错误被误报为「未命中」**：\`count\` 传 0 / 负数 / 非数字时，原先被 \`parseInt(...) || 0\` 归零并被静默短路，最终回复"范围内未命中"——会让 AI 误以为文本没匹配上而放宽 scope 甚至改成 \`scope=all\` 重试；现在非法 \`count\` 直接报参数错。\`scope\` 的 \`idx:\` 写法非法或越界也改为显式报错（此前一律退化成"未命中"），越界区间被收敛时在回复中标注实际生效范围
- 修复**工具组同名撞车导致误开关**：内置分类名与 MCP 服务器名原先共用同一聚合键，一台名为「记忆」的 MCP 服务器会被并进内置「记忆」组（概览显示成 \`内置·记忆\`），\`.ai tool off 记忆\` 会连带关掉 MCP 工具且完全看不出来；现在按「内置/MCP」分别成组，同名时按组名解析会报歧义而不是静默选中
- 修复**\`.ai off\` 未知参数被静默忽略**：开关分支没有 default，\`--standb\` 这类拼写错误会被完全忽略却照旧回复"AI已关闭："，用户误判为已生效；现在会回显未识别的参数名，一个有效参数都没有时明确回复"未做任何更改"
- 修复 \`media_template.ts\` 的联合类型未收窄（\`Property 'error' does not exist\`）：改判 \`coerced.ok === false\`。同时**修正 CI 的类型门禁**——原 \`npx tsc --noEmit --strict\` 的命令行 \`--strict\` 会覆盖 tsconfig 严格选项，把该错误静默吞掉（同一份代码 tsconfig 直跑 exit=2，加 \`--strict\` 后 exit=0），现改为直跑 tsconfig；并把 \`npm run test:unit\` 接入 build-check 与 release 工作流（此前 279 项单测在 CI 中完全不执行）
`;
