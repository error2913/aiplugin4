// OB11 API 默认技能：统一指导 AI 通过唯一工具 call_ob11_api 调用协议动作。
// 这里刻意不注册任何按功能拆分的旧工具；动作仍然以 OneBot 11 action 原名传入。
export const OB11_API_SKILLS = [
    `---
name: ob11-api
description: 通过唯一的 call_ob11_api 工具调用 OneBot 11/兼容协议 API，覆盖消息、媒体、文件、合并转发、查询和群管理
---
# OB11 API 调用规范

## 0. 先分清「回复当前会话」与「主动外发/特殊消息」
- 用户在当前会话向你提问或聊天时，直接输出文本回复即可，回复会自动发送到当前会话，不要为回复当前会话调用 call_ob11_api。
- call_ob11_api 只用于：主动向指定私聊/群聊外发消息（定时任务、代发、转发等），或发送当前回复表达不了的特殊消息段（语音/视频/文件等）。
- 回复文本中可直接夹带 [img:图片ID]、[at:ID]、[quote:ID]、[poke:ID]、[face:名称] 等可发送标签。

## 1. 唯一入口
所有 OB11/协议端操作只能使用工具 **call_ob11_api**，不要寻找或调用任何已删除的按功能拆分工具。工具参数：


data：
{
  "action": "send_group_msg",
  "params": {
    "group_id": "123456",
    "message": [
      {"type": "text", "data": {"text": "你好"}},
      {"type": "image", "data": {"file": "resource:图片名"}}
    ]
  },
  "reason": "可选：说明发送或管理操作的目的"
}

\`action\` 是原始 OneBot 11 action 字符串，\`params\` 必须是该 action 的原始参数对象；不要把 action 改写成工具名，不要再套一层 \`params.params\`。结果是 JSON：成功为 \`{"ok":true,...}\`，失败为 \`{"ok":false,"error":{"code":...}}\`。

## 2. ID、目标和返回值
- \`user_id\`、\`group_id\`、\`message_id\`、\`message_seq\` 等 ID 可传数字或字符串；优先使用当前上下文给出的 QQ号、群号或对应 ID，不要擅自把群号当用户号。
- 私聊发送：\`action="send_private_msg"\`，参数 \`{"user_id":"用户ID","message":...}\`。
- 群聊发送：\`action="send_group_msg"\`，参数 \`{"group_id":"群ID","message":...}\`。
- 发送成功时通常返回 \`message_id\`；后续引用、撤回、回复应优先使用这个值。
- \`send_msg\` 不是本工具入口。需要发送时根据场景明确选择 \`send_private_msg\` 或 \`send_group_msg\`。
- 管理、删除、加好友等有副作用的 action 只有在用户意图明确时调用；\`reason\` 只用于记录意图，不会替代 API 参数，也不会绕过权限。

## 2.5 特殊 ID、句柄与媒体引用
- 上下文里的 ID 都是插件渲染的短形式，不要把短 ID/句柄或标签原样外发：
  - 消息 ID：base36 短 ID（\`[msg_id:xxx]\`/\`[quote:xxx]\`）
  - 图片：6 位图片 ID（\`[img:图片ID]\`，或带描述的 \`[img:图片ID:描述]\`）
  - 语音/视频/文件：闭合标签 \`[record:句柄]摘要[/record]\`、\`[video:句柄]摘要[/video]\`、\`[file:句柄]摘要[/file]\`，句柄在开标签参数里
- 需要还原成协议端能用的原始值（\`message_id\`/\`file\`/\`url\`/\`path\`/\`file_id\`/\`file_unique\` 等）时，先调用 \`resolve_special_id(type=message/image/record/video/file, id=短ID或句柄)\`；\`id\` 可以传整个标签（含闭合形式），也可以只传句柄。
- \`get_msg\`/\`delete_msg\`/\`set_essence_msg\` 等 action 的 \`message_id\`、\`get_image\`/\`get_record\` 的 \`file\` 也支持直接传上下文短 ID/句柄，\`call_ob11_api\` 会自动还原；复杂场景建议先用 \`resolve_special_id\` 查询确认。
- **已有完整 url/path/base64 时直接用，不要调 \`get_image\`/\`get_record\` 转换**：这两个接口只接受协议端缓存文件名（如 \`xxx.image\`/\`voice.amr\`）或上下文短 ID/句柄；把下载 URL 传给它们会返回 \`file not found\`。已拿到 url 的图片/语音直接使用 url 即可。

## 3. message 格式
\`message\` 可以是纯文本字符串，也可以是 OneBot 11 消息段数组。消息段统一格式为 \`{"type":"类型","data":{...}}\`。可混排，数组顺序就是发送顺序。

常用消息段：
- 文本：\`{"type":"text","data":{"text":"文字"}}\`
- QQ 表情：\`{"type":"face","data":{"id":"123"}}\`。上下文中普通 QQ 表情显示为 \`[face:表情名]\`（可发送）；商城表情/超级表情显示为 \`[face]表情名[/face]\`（仅供阅读，不能直接发送，需要时按对应协议段构造）。
- 图片：\`{"type":"image","data":{"file":"绝对路径、URL、base64://... 或 resource:资源名"}}\`
- 语音：\`{"type":"record","data":{"file":"绝对路径、URL、base64://... 或 resource:资源名","magic":0}}\`
- 视频：\`{"type":"video","data":{"file":"绝对路径、URL、base64://... 或 resource:资源名"}}\`
- 文件消息：\`{"type":"file","data":{"file":"绝对路径、URL、base64://... 或 resource:资源名","name":"可选文件名"}}\`
- @：\`{"type":"at","data":{"qq":"用户ID"}}\`；全体成员可用 \`qq:"all"\`（以协议端支持为准）。
- 回复：\`{"type":"reply","data":{"id":"消息ID"}}\`
- 戳一戳：\`{"type":"poke","data":{"qq":"用户ID"}}\`
- 骰子 / 猜拳：\`{"type":"dice","data":{}}\`、\`{"type":"rps","data":{}}\`
- 音乐：见第 5 节。
- JSON / Markdown：见第 6 节。
- 合并转发 node：见第 7 节。

不要把图片、语音、视频或文件静默改成文本路径；必须保留对应 segment type。资源路径无法解析时应让工具返回错误并修正路径，不要假装发送成功。

## 4. 本地资源引用
- 当前会话回复中发送图片，优先直接输出 \`[img:资源ID]\`，不需要调用 \`call_ob11_api\`。
- 需要发送插件资源时，先调用 \`list_resources\` 查询资源 ID（这是资源查询工具，不是发送工具）。
- \`call_ob11_api\` + \`resource:资源ID\` 用于发送语音/视频/文件，或向指定会话/按 API 组合消息发送图片。例如：

{"action":"send_group_msg","params":{"group_id":"123","message":[{"type":"image","data":{"file":"resource:角色头像"}}]}}

也可以直接传本地绝对路径、\`file://\` URI、HTTP(S) URL 或 \`base64://\` 内容。MCP 导出的文件使用 \`mcp://服务器名/沙箱相对路径\` 或已解析的可访问 URL。不要只传用户可见的文件名，除非该文件名就是 \`resource:\` 引用。

## 5. 图片、语音、视频和文件的区别
- 图片/语音/视频作为消息内容发送：使用 \`send_private_msg\` / \`send_group_msg\`，把对应 segment 放进 \`message\`。
- 上传文件到群文件区或私聊文件区：使用 \`upload_group_file\` / \`upload_private_file\`，例如：
  \`{"action":"upload_group_file","params":{"group_id":"123","file":"/data/a.zip","name":"a.zip"}}\`。
- 上传 action 的 \`file\` 也支持 \`resource:资源ID\`；工具会先解析到已配置资源的实际路径，再交给文件上传 API。
- \`file\` 消息段是消息中的文件卡片，不等同于 \`upload_group_file\`；不要用普通 \`file\` segment 冒充群文件区上传。
- 语音生成先使用 \`generate_audio\` 得到 record segment，再把该 segment 原样交给 \`call_ob11_api\`。
- 音乐搜索先使用 \`search_music\` 得到 music segment，再把该 segment 放入发送 action；不要直接发送，继续使用 \`call_ob11_api\`。

## 6. JSON、Markdown、音乐
- JSON：\`{"type":"json","data":{"data":"JSON字符串"}}\`。保留合法 JSON 字符串；协议端不支持时工具会返回失败，不要擅自改成普通文本。
- Markdown：\`{"type":"markdown","data":{"content":"# 标题\\n正文"}}\` 或按协议端要求使用 \`data\` 字段。
- QQ 音乐：\`{"type":"music","data":{"type":"qq","id":"歌曲ID"}}\`。
- 网易云音乐：\`{"type":"music","data":{"type":"163","id":"歌曲ID"}}\`。
- 自定义音乐：\`{"type":"music","data":{"type":"custom","url":"展示页","audio":"音频URL","title":"标题","content":"作者/描述","image":"封面URL"}}\`。
- JSON/Markdown/music 是协议端特殊消息，不要在安装依赖缺失时把它们伪装成普通文字。

## 7. 合并转发
- 已有转发消息 ID：可在 \`message\` 中使用 \`{"type":"forward","data":{"id":"转发ID"}}\`（原生 SealDice 仅能尽力编码该引用）。
- 需要构造新的合并转发：使用 \`send_group_forward_msg\` 或 \`send_private_forward_msg\`，并按当前协议端的 \`messages\` / \`messages\` 节点格式提供 node；这类远端动作需要 ob11 网络连接依赖。
- node 示例：\`{"type":"node","data":{"user_id":"10001","nickname":"昵称","content":[{"type":"text","data":{"text":"内容"}}]}}\`。不同协议端对 node 字段可能有差异，优先遵循当前端点文档。

## 8. action 方法合集（三层）
\`call_ob11_api\` 以 OneBot 11（OB11）action 名为入口，不新增包装名。当前端点能力分三层，均按原名透传：

### 8.1 OB11 标准 action（38 个，兼容端点通用）
- 消息：\`send_private_msg\`、\`send_group_msg\`、\`send_msg\`、\`delete_msg\`、\`get_msg\`、\`get_forward_msg\`、\`send_like\`
- 群管理：\`set_group_kick\`、\`set_group_ban\`、\`set_group_anonymous_ban\`、\`set_group_whole_ban\`、\`set_group_admin\`、\`set_group_anonymous\`、\`set_group_card\`、\`set_group_name\`、\`set_group_leave\`、\`set_group_special_title\`
- 请求：\`set_friend_add_request\`、\`set_group_add_request\`
- 查询：\`get_login_info\`、\`get_stranger_info\`、\`get_friend_list\`、\`get_group_info\`、\`get_group_list\`、\`get_group_member_info\`、\`get_group_member_list\`、\`get_group_honor_info\`
- 账号/工具：\`get_cookies\`、\`get_csrf_token\`、\`get_credentials\`、\`get_record\`、\`get_image\`、\`can_send_image\`、\`can_send_record\`、\`get_status\`、\`get_version_info\`、\`set_restart\`、\`clean_cache\`

### 8.2 NapCat/兼容端点扩展（128 个，原样透传）
已安装 ob11 网络连接依赖时，NapCat 等端点的扩展 action 也按原名透传，常见代表：
- 消息扩展：\`send_group_forward_msg\`、\`send_private_forward_msg\`、\`send_forward_msg\`、\`set_essence_msg\`、\`delete_essence_msg\`、\`get_essence_msg_list\`、\`set_msg_emoji_like\`、\`get_group_msg_history\`、\`get_friend_msg_history\`、\`get_ai_record\`、\`send_group_ai_record\`、\`send_private_ai_record\`
- 群文件：\`upload_group_file\`、\`upload_private_file\`、\`get_group_file_url\`、\`get_group_root_files\`、\`get_group_files_by_folder\`、\`create_group_file_folder\`、\`delete_group_file\`、\`delete_group_folder\`、\`move_group_file\`、\`rename_group_file\`、\`get_private_file_url\`、\`get_group_file_system_info\`、\`trans_group_file\`
- 群管理扩展：\`set_group_portrait\`、\`set_group_remark\`、\`set_group_member_invite_policy\`、\`set_group_member_permissions\`、\`set_group_new_member_history_visibility\`、\`set_group_kick_members\`、\`get_group_system_msg\`、\`get_group_shut_list\`、\`send_group_sign\`、\`set_group_sign\`、\`get_group_at_all_remain\`、\`_send_group_notice\`、\`_get_group_notice\`、\`_del_group_notice\`
- 头像/资料/状态：\`set_qq_avatar\`、\`set_qq_profile\`、\`set_self_longnick\`、\`set_online_status\`、\`set_diy_online_status\`、\`get_online_clients\`、\`get_robot_uin_range\`、\`get_clientkey\`、\`get_rkey\`、\`get_rkey_server\`、\`nc_get_rkey\`、\`nc_get_packet_status\`、\`nc_get_user_status\`
- 戳一戳/表情/收藏：\`group_poke\`、\`friend_poke\`、\`send_poke\`、\`fetch_custom_face\`、\`fetch_custom_face_detail\`、\`add_custom_face\`、\`delete_custom_face\`、\`set_custom_face_desc\`、\`fetch_emoji_like\`、\`get_emoji_likes\`、\`create_collection\`、\`get_collection_list\`
- 转发/翻译/OCR/键盘：\`forward_friend_single_msg\`、\`forward_group_single_msg\`、\`translate_en2zh\`、\`fetch_ptt_text\`、\`ocr_image\`、\`click_inline_keyboard_button\`
- 闪照/在线文件/空间：\`send_flash_msg\`、\`create_flash_task\`、\`get_flash_file_list\`、\`get_flash_file_url\`、\`get_fileset_id\`、\`get_fileset_info\`、\`download_fileset\`、\`send_online_file\`、\`send_online_folder\`、\`get_online_file_msg\`、\`receive_online_file\`、\`refuse_online_file\`、\`cancel_online_file\`、\`send_qzone_msg\`、\`delete_qzone_msg\`
- 其他：\`delete_friend\`、\`mark_msg_as_read\`、\`mark_group_msg_as_read\`、\`mark_private_msg_as_read\`、\`_mark_all_as_read\`、\`get_recent_contact\`、\`get_unidirectional_friend_list\`、\`set_input_status\`、\`get_profile_like\`、\`get_group_ignore_add_request\`、\`get_group_ignored_notifies\`、\`send_packet\`、\`get_mini_app_ark\`、\`get_guild_list\`、\`get_guild_service_profile\`、\`get_share_link\`、\`download_file\`、\`check_url_safely\`、\`get_file\`、\`set_friend_remark\`、\`get_doubt_friends_add_request\`、\`set_doubt_friends_add_request\`、\`set_group_todo\`、\`complete_group_todo\`、\`cancel_group_todo\`、\`get_group_album_media_list\`、\`del_group_album_media\`、\`set_group_album_media_like\`、\`cancel_group_album_media_like\`、\`do_group_album_comment\`、\`upload_image_to_qun_album\`、\`get_qun_album_list\`、\`get_friends_with_category\`、\`get_group_info_ex\`、\`get_group_detail_info\`、\`get_group_signed_list\`
- **未列出的 action 也原样透传**：只要端点支持即可调用；参数按端点文档提供，本工具不做转换。

### 8.3 旧 Milky 方法名（兼容层）
当前端点若使用海豹 Milky 兼容层（sealdice-plugin-ob11-net-connection），还接受一批 Milky 风格方法名（\`get_impl_info\`、\`get_friend_info\`、\`get_user_profile\`、\`send_friend_nudge\`、\`send_group_nudge\`、\`set_group_member_mute\`、\`set_group_member_admin\`、\`set_group_member_card\`、\`set_group_avatar\`、\`set_avatar\` 等约 39 个），依赖层会自动转写为对应 OB11/NapCat action。无对应等价 action 的 Milky 方法（约 12 个，如 \`get_peer_pins\`、\`get_friend_requests\`、\`accept_friend_request\` 等）会明确返回 unsupported。优先使用 OB11 标准/NapCat 扩展原名，兼容层方法仅在需要时使用。

## 9. ob11 依赖是否安装
运行时每次调用都会检测 \`globalThis.net\`，不需要用户手动选择后端：
- 已安装 ob11 网络连接依赖：调用 \`net.callApi\`；\`upload_*_file\` 优先使用统一的 \`net.sendFile\`，保留端点对文件上传的特殊实现；所有协议 action、特殊消息、列表、管理和远端合并转发都可按端点能力执行。
- 未安装依赖：仍使用 SealDice 原生后端完成当前上下文可完成的 \`send_private_msg\`、\`send_group_msg\`、\`get_login_info\`、\`get_status\`、\`get_version_info\`、\`get_group_info\`、\`get_group_member_info\`、\`get_stranger_info\`。文本、图片、语音、视频、文件、at、reply、face、poke、dice、rps、music、json、markdown 等消息段会尽力转换为 SealDice/CQ 内容；不支持的 node 或远程 forward 不会静默丢弃。
- 未安装依赖时，列表、历史、撤回、群管理、群文件上传、远程合并转发和未知 action 返回 \`error.code="OB11_DEPENDENCY_REQUIRED"\`。不要重复重试；先安装依赖，或改用原生可完成的 action。
- 如果 native 发送返回 \`NATIVE_ACTION_UNSUPPORTED\` / \`NATIVE_CONTEXT_UNAVAILABLE\`，这是当前上下文能力不足，不代表协议端已成功。

## 10. 调用纪律
1. 先确认目标场景和 ID，再组装 action/params。
2. 发送特殊消息时使用 segment 数组，保持 type 和 data 字段，不要压扁为文本。
3. 看到 \`OB11_DEPENDENCY_REQUIRED\` 时停止重复调用并明确告知缺少依赖。
4. 看到 \`OB11_API_ERROR\` 时根据错误决定是否重试；不要盲目重复有副作用的 action。
5. 旧工具已彻底移除；不要创建别名、兼容调用或猜测旧工具仍可用。`
];

