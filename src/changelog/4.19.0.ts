// 版本更新日志（数据文件）：4.19.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 新增评分触发（.ai on --j）：由评分智能体判断群聊消息是否值得机器人插话，避免待机时对无关消息强行回复。消息先入库，gate 门禁（零 LLM）先丢弃明显不该触发的情况（精力不足/消息过密/每小时次数用尽/已有待触发计时器），通过后再由评分智能体按五维（相关度/意愿度/社交价值/时机/延续性）加权评分
- 评分结果两级：得分≥speak_threshold 直接插话（SPEAK）；低于 speak_threshold 进入 WAIT 轮，wait_cooldown 秒内新消息不评分、挂起轮末最新一条重新过 gate；WAIT 轮按时间戳判定，由内置定时器在轮末兜底触发重判
- 其他方式触发会话（正则/计数器/概率/计时器/AI设定触发条件等）同样以一轮 WAIT 作为冷却（bot 刚发言/刚被触发即冷却），轮内新消息挂起、轮末重新过 gate，避免各触发方式互相刷屏；会话结束（.ai off/.ai stop）时清理轮内挂起消息，不再重判；精力仅在评分判定 SPEAK 插话成功时扣减
- 评分详情（输入、注入、维度分、加权总分、判定、gate DROP 原因、重试/超时、WAIT 轮挂起/轮末重判）以 [judge] 标签打印到日志
- 新增 .ai model：无参查看当前模型与可用模型列表（多模态条目标注）；.ai model <模型名> 设置当前会话使用的模型（按会话覆盖，可选中多模态模型里 use 含 chat 的条目）；.ai model clr 恢复默认
- 记忆 v2 全面升级：.ai memo 重构为 status / add / list / update / delete / clear / obs / consolidate / reflect / mm 子命令；范围参数改用 --u（本人个人记忆）/ --g（当前群），--u=<ID> / --g=<ID> 可查看他人/其他群记忆（仅骰主），默认当前会话、二者不能同用
- 新增心智模型（.ai memo mm）：基于记忆自动推理对用户/群的理解（question/answer + 范围标签），支持 list / view / add / refresh / del；巩固记忆后自动刷新（可配置最小间隔），.ai memo reflect <问题> 可按需基于记忆推理
- 记忆检索新增 Hindsight 式新近度加权：最近使用/验证过的记忆在同等相关度下更靠前（按「记忆召回新近度权重」指数衰减，只影响排序、不删旧记忆）
- 记忆注入裁剪：心智模型/观察记忆按范围标签严格过滤、剔除 90 天过期观察、各取最新 5/20 条注入，控制上下文 token
- .ai stop 真正停止一切：StopEvent 打断模型请求/工具链/排队/续跑，不再有「stop 后仍继续回话」的残留

## 配置变更
- 「消息触发」页签新增「评分触发配置」（分段 TOML，缺省段/字段使用默认值）：[scoring] speak_threshold / wait_cooldown、[weights] 五维权重、[energy] initial / reply_cost / recover_min、[gate] max_judge_per_hour、[model] context_count / timeout_sec / retries
- 纯文本模型 use 新增 judge 用途：可为评分智能体单独配置模型，未单独配置时自动回退 chat 模型（仅模型配置描述与示例变化，解析结构不变）
- .ai off --j 单独关闭评分触发并清理其 WAIT 轮与内存状态；.ai stop 同样清理
- 「图片模型」更名为「多模态模型」：列表内模型一律按多模态处理——use 含 image-understanding 用于识图，use 含 chat/compression/summarization/judge 可当对应用途的对话模型使用（上下文图片直接传模型，不再转文本标签）；同名模型若同时出现在「纯文本模型」列表，按纯文本模型优先
- 「是否开启图片模型」更名为「是否开启识图模型」：只影响图片识别/图片转文字（image-understanding），多模态对话不受该开关控制
- 旧配置键「图片模型」「是否开启图片模型」已删除，不再兼容读取（老用户需重新配置）
- 「对话模型」更名为「纯文本模型」：模型配置新增 ignore 字段（1=忽略该条配置，不出现在列表/不可选中/不作为默认，0/不写=正常）；旧配置键「对话模型」已删除，不再兼容读取（老用户需重新配置）
- 移除「是否开启识图模型」「是否开启嵌入模型」两个开关：改由对应模型是否配置启用（未配置即不生效）；旧配置键「是否开启识图模型」「是否开启嵌入模型」已删除，不再兼容读取（老用户需重新配置）
- 记忆配置新增：「记忆召回新近度权重」（默认 0.4）、「记忆召回新近度半衰期」（默认 60 天）、「用LLM推理记忆」（默认开启，.ai memo mm / reflect 使用）、「巩固后自动刷新心智模型」（默认开启）、「心智模型刷新最小间隔」（默认 30 分钟）
- 「通知事件白名单」默认值更新：默认收录 NapCat/OneBot 可上报的绝大多数通知/请求事件（禁言、管理变动、文件上传、群名片变更、成员增减、撤回、群名变更、群头衔变更、资料点赞、精华、表情回应、运气王/群荣誉、入群/好友申请等）；notify 为通知大类，其子类型需单独在白名单内才收录（默认含 lucky_king/honor/group_name/title/profile_like），gray_tip（灰条，内容为 JSON 且可伪造）与 input_status（输入状态，纯噪音）未默认收录，需要可自行加入对应子类型名

## 修复
- 图片转 base64 连续失败达到 3 次后永久放弃重试：不再按 1 小时冷却期周期反复请求，避免过期链接一直重试
- 修复多模态模型（use=chat）作为会话模型时请求仍发给全局默认对话模型的问题：Agent.chat/chatMessages 现将解析到的模型实例显式传给请求层，会话级 .ai model 指定专属模型真正生效
- 修复「事件接收」白名单不完整：补全 NapCat/OneBot 可上报的通知事件（群名片变更、群名/头衔变更、资料点赞、精华、表情回应、解散群等），消息贴表情（group_msg_emoji_like）现在会真正录入上下文；移除 NapCat 不存在的死类型（group_whole_mute/peer_pin_change/friend_file_upload 等）
- 修复 .ai stop 中止不彻底：stop 时置位 StopEvent 并唤醒所有等待中的模型请求/超时等待（以 StopError 中断）、归零活跃运行计数、清空挂起队列与待触发计时器，StopError 不计为工具失败；goja 无 AbortController 无法硬中断底层 fetch，但返回结果会被丢弃
`;
