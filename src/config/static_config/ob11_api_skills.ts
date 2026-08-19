// OB11 API 默认技能：统一指导 AI 通过唯一工具 call_ob11_api 调用协议动作。
// 这里刻意不注册任何按功能拆分的旧工具；动作仍然以 OneBot 11 action 原名传入。
export const OB11_API_SKILLS = [
    `---
name: ob11-api
description: 通过唯一的 call_ob11_api 工具调用 OneBot 11/兼容协议 API，覆盖消息、媒体、文件、合并转发、查询和群管理
---
# OB11 API 调用规范

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

## 3. message 格式
\`message\` 可以是纯文本字符串，也可以是 OneBot 11 消息段数组。消息段统一格式为 \`{"type":"类型","data":{...}}\`。可混排，数组顺序就是发送顺序。

常用消息段：
- 文本：\`{"type":"text","data":{"text":"文字"}}\`
- QQ 表情：\`{"type":"face","data":{"id":"123"}}\`
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
需要发送插件资源时，先调用 \`list_resources\` 查询资源 ID（这是资源查询工具，不是发送工具），然后在消息段中写 \`resource:资源ID\`。例如：

{"action":"send_group_msg","params":{"group_id":"123","message":[{"type":"image","data":{"file":"resource:角色头像"}}]}}

也可以直接传本地绝对路径、\`file://\` URI、HTTP(S) URL 或 \`base64://\` 内容。MCP 导出的文件使用 \`mcp://服务器名/沙箱相对路径\` 或已解析的可访问 URL。不要只传用户可见的文件名，除非该文件名就是 \`resource:\` 引用。

## 5. 图片、语音、视频和文件的区别
- 图片/语音/视频作为消息内容发送：使用 \`send_private_msg\` / \`send_group_msg\`，把对应 segment 放进 \`message\`。
- 上传文件到群文件区或私聊文件区：使用 \`upload_group_file\` / \`upload_private_file\`，例如：
  \`{"action":"upload_group_file","params":{"group_id":"123","file":"/data/a.zip","name":"a.zip"}}\`。
- 上传 action 的 \`file\` 也支持 \`resource:资源ID\`；工具会先解析到已配置资源的实际路径，再交给文件上传 API。
- \`file\` 消息段是消息中的文件卡片，不等同于 \`upload_group_file\`；不要用普通 \`file\` segment 冒充群文件区上传。
- 语音生成先使用 \`generate_audio\` 得到 record segment，再把该 segment 原样交给 \`call_ob11_api\`；直接把 record segment 交给 \`call_ob11_api\`。
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

## 8. 常用 action 分类
以下是常用原始 action，不是额外工具名：
- 消息：\`send_private_msg\`、\`send_group_msg\`、\`get_msg\`、\`delete_msg\`、\`get_forward_msg\`、\`send_group_forward_msg\`、\`send_private_forward_msg\`。
- 查询：\`get_login_info\`、\`get_status\`、\`get_version_info\`、\`get_group_info\`、\`get_group_list\`、\`get_group_member_info\`、\`get_group_member_list\`、\`get_friend_list\`、\`get_stranger_info\`、\`get_group_msg_history\`、\`get_friend_msg_history\`。
- 群管理：\`set_group_kick\`、\`set_group_ban\`、\`set_group_whole_ban\`、\`set_group_admin\`、\`set_group_card\`、\`set_group_name\`、\`set_group_leave\`、\`set_group_special_title\`、\`send_group_sign\`。
- 请求与好友：\`send_like\`、\`set_friend_add_request\`、\`set_group_add_request\`。
- 群文件：\`upload_group_file\`、\`upload_private_file\`、\`get_group_file_url\`、\`get_group_root_files\`、\`get_group_files_by_folder\`、\`create_group_file_folder\`、\`delete_group_file\`、\`delete_group_folder\`、\`move_group_file\`、\`rename_group_file\`、\`get_private_file_url\`。
- 账号/缓存：\`get_cookies\`、\`get_csrf_token\`、\`get_credentials\`、\`get_record\`、\`get_image\`、\`can_send_image\`、\`can_send_record\`、\`set_qq_avatar\`、\`set_qq_profile\`、\`set_group_portrait\`、\`set_restart\`、\`clean_cache\`。
- 未列出的 action：如果已安装 ob11 网络连接依赖，统一入口会原样透传给协议端；没有依赖时不能执行未知 action，也不能猜测结果。

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

