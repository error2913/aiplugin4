// 版本更新日志（数据文件）：4.19.3。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 修复
- 定时器变更改为即时落盘（写穿）：此前定时器在到点执行、间隔更新等变更后先改内存、再定时批量落盘，重载 JS / 杀进程会丢失最近变更；现在每次变更（新增/移除/间隔更新/到点执行/超时忽略）都同步写入存储
- 修复重载 JS 后定时器队列恒空：恢复存档时的过滤条件与存档字段不一致（用 sessionId/sessionType 匹配 sid/isPrivate），导致所有定时器被过滤、重载后队列清空；现按实际存档字段恢复，旧格式条目自动跳过
- 挂起消息队列改为轻量分片持久化（session_<sid>:pending）：此前挂起队列随会话整存整取，含不可序列化的运行时 ctx/msg 对象；现只落盘重建所需字段（内容/用户/消息ID/类型/原因/epId/isPrivate），重载 JS 后按 epId/isPrivate 重建上下文续跑，队列清空时同步清档避免脏数据复活
- 修复 .ai memo mm del 删除失效：del 经别名归一化为 delete 后未命中删除分支，实际返回帮助文本；现按归一化目标匹配，del / delete 均可删除，并支持按问题名或关键词删除（唯一命中直接删，多条列出 ID 由用户指定）
- 修复心智模型/观察记忆注入丢失：范围标签由「全部命中」放宽为「任一命中」，群聊中不再因某发言者不在最近消息而整条被剔除；memory_mm_create / .ai memo mm add 的自定义范围标签非法或与目标类型不符时自动回退默认标签
- 修复观察记忆重复注入与滞后：启用长期记忆时观察只由长期记忆段注入（上限 20 条 + 90 天过期剔除），不再重复渲染；巩固生成观察后立即刷新观察记忆缓存，消除最长 60 秒滞后
- 记忆/知识库工具描述修正：memory_update 引用的 search_memory 改为 memory_recall；knowledge_read 引用的 kb_list/kb_search 改为 knowledge_list/knowledge_search

## 变更
- 记忆 v2 存储拆分为 5 个分片 key（memv2:<bankId>:meta/units/links/docs/obs）：按变更分片重写，避免整库大 JSON 反复全量序列化；旧版单 key（memv2:<bankId>:bank）首次读取时一次性自动迁移并清空旧 key
- 记忆写入收敛：retain / consolidate 全程内存累计变更、末尾统一落盘一次（原逐条整库序列化）；consolidate 触发条数上限淘汰时，淘汰结果即时落盘，不再停留在内存（重载后不会复活）
- 知识库注入只展示条目索引：system prompt 不再注入知识库正文，只列条目（ID + 标题，1500 字符预算内尽可能多列，最多 100 条），详情由模型用 knowledge_read 按 ID 读取；knowledge_list 工具与 .ai kb list 索引上限 200 条
- 可用技能段只展示技能摘要：1500 字符预算内尽可能多列，超出部分用 skill_list 查看完整列表、use_skill 按需获取内容
- 群聊记忆按「群聊 / 每个最近发言者」分组注入：每组独立渲染长期记忆与心智模型，避免多个归属混在一起造成混淆；群心智模型 ≤5、群观察 ≤20，个人记忆每用户最多 5 条（单用户 2048 字符预算）、个人心智模型每用户最多 2 条；私有记忆仅创建者本人可见

## 新功能
- 新增 memory_mm_list / memory_mm_view 工具：模型可列出/查看心智模型；memory_mm_delete 支持按问题名删除
- 新增 skill_list 工具：列出全部技能名称与描述
- .ai memo status 显示心智模型将注入条数
`;
