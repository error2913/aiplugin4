// OB11 API 知识库默认内容（「知识库」配置的一个默认条目）：统一指导 AI 通过唯一工具 call_ob11_api 调用协议动作。
// 原为默认技能，已改写为知识库并限定 platform: [QQ]（仅 QQ 平台可见可检索）。
import { PROTOCOL_AI_VOICE_CHARACTERS } from "./ai_voice_characters";

export const OB11_API_KB = `---
name: ob11-api
description: Call OneBot 11/compatible protocol APIs through the single tool call_ob11_api, covering messages, media, files, forwarded messages, queries and group management; QQ platform only
platform: [QQ]
---
# OB11 API call specification

## 0. Distinguish "replying to the current conversation" from "proactive sending / special messages"
- When a user asks or chats with you in the current conversation, just reply with text: the reply is delivered to the current conversation automatically. Do not call call_ob11_api just to reply here.
- call_ob11_api is only for: proactively sending to a specific private chat/group (scheduled tasks, sending on behalf of someone, forwarding, etc.), or sending special message segments the current reply cannot express (voice/video/file, etc.).
- Reply text may directly contain sendable tags such as [img:image-id], [at:ID], [quote:ID], [poke:ID], [face:name].

## 1. Single entry point
All OB11/protocol operations must use the tool **call_ob11_api**; do not look for or call any of the removed per-feature tools. Tool arguments:

data:
{
  "action": "send_group_msg",
  "params": {
    "group_id": "123456",
    "message": [
      {"type": "text", "data": {"text": "Hello"}},
      {"type": "image", "data": {"file": "resource:<image name>"}}
    ]
  },
  "reason": "optional: why this send or management action is performed"
}

\`action\` is the raw OneBot 11 action string and \`params\` must be that action's raw parameter object; do not turn action into a tool name and do not wrap another \`params.params\` layer. The result is JSON: \`{"ok":true,...}\` on success, \`{"ok":false,"error":{"code":...}}\` on failure.

## 2. IDs, targets and return values
- IDs such as \`user_id\`, \`group_id\`, \`message_id\` and \`message_seq\` may be numbers or strings; prefer the QQ number, group number or corresponding ID given in the current context, and never treat a group number as a user number.
- Private-chat send: \`action="send_private_msg"\` with params \`{"user_id":"<user ID>","message":...}\`.
- Group send: \`action="send_group_msg"\` with params \`{"group_id":"<group ID>","message":...}\`.
- A successful send usually returns \`message_id\`; prefer this value for later quoting, recalling and replying.
- \`send_msg\` is not this tool's entry point. Choose \`send_private_msg\` or \`send_group_msg\` explicitly according to the scenario.
- Actions with side effects (management, deletion, friend requests, etc.) may only be called when the user's intent is clear; \`reason\` only records intent — it neither replaces API params nor bypasses permissions.

## 2.5 Special IDs, handles and media references
- IDs in the context are short forms rendered by the plugin; never send short IDs/handles or tags out as-is:
  - Message ID: base36 short ID (\`[msg_id:xxx]\`/\`[quote:xxx]\`)
  - Image: 6-character image ID (\`[img:image-id]\`, or \`[img:image-id:description]\` with a description)
  - Voice/video/file: closed tags \`[record:handle]summary[/record]\`, \`[video:handle]summary[/video]\`, \`[file:handle]summary[/file]\`; the handle is in the opening tag's parameters
- To restore the raw values usable by the protocol side (\`message_id\`/\`file\`/\`url\`/\`path\`/\`file_id\`/\`file_unique\`, etc.), first call \`resolve_special_id(type=message/image/record/video/file, id=<short ID or handle>)\`; \`id\` accepts the whole tag (including the closed form) or just the handle.
- The \`message_id\` of actions such as \`get_msg\`/\`delete_msg\`/\`set_essence_msg\` and the \`file\` of \`get_image\`/\`get_record\` also accept context short IDs/handles directly, and \`call_ob11_api\` restores them automatically; in complex scenarios query with \`resolve_special_id\` first to confirm.
- **When a full url/path/base64 is already available, use it directly and do not call \`get_image\`/\`get_record\` to convert**: those two APIs only accept the protocol-side cache file name (such as \`xxx.image\`/\`voice.amr\`) or a context short ID/handle; passing a download URL returns \`file not found\`. Use the url directly for images/voice that already have one.

## 3. message format
\`message\` can be a plain text string or a OneBot 11 message-segment array. Every segment has the form \`{"type":"<type>","data":{...}}\`. Segments can be mixed, and array order is send order.

Common segments:
- Text: \`{"type":"text","data":{"text":"text"}}\`
- QQ emoji: \`{"type":"face","data":{"id":"123"}}\`. In the context, ordinary QQ emoji appear as \`[face:name]\` (sendable); shop/super emoji appear as \`[face]name[/face]\` (read-only, not directly sendable — when needed, construct the corresponding protocol segment).
- Image: \`{"type":"image","data":{"file":"absolute path, URL, base64://... or resource:<name>"}}\`
- Voice: \`{"type":"record","data":{"file":"absolute path, URL, base64://... or resource:<name>","magic":0}}\`
- Video: \`{"type":"video","data":{"file":"absolute path, URL, base64://... or resource:<name>"}}\`
- File message: \`{"type":"file","data":{"file":"absolute path, URL, base64://... or resource:<name>","name":"optional file name"}}\`
- @: \`{"type":"at","data":{"qq":"<user ID>"}}\`; all members can be mentioned with \`qq:"all"\` (subject to protocol-side support).
- Reply: \`{"type":"reply","data":{"id":"<message ID>"}}\`
- Poke: \`{"type":"poke","data":{"qq":"<user ID>"}}\`
- Dice / rock-paper-scissors: \`{"type":"dice","data":{}}\`, \`{"type":"rps","data":{}}\`
- Music: see section 5.
- JSON / Markdown: see section 6.
- Forwarded-message node: see section 7.

Never silently turn an image, voice, video or file into a text path; keep the corresponding segment type. If a resource path cannot be resolved, let the tool return an error and fix the path instead of pretending the send succeeded.

## 4. Local resource references
- To send an image in the current conversation, prefer outputting \`[img:<resource ID>]\` directly; calling \`call_ob11_api\` is not required.
- To send a plugin resource, first call \`list_resources\` to look up the resource ID (that is a resource-lookup tool, not a send tool).
- Use \`call_ob11_api\` + \`resource:<resource ID>\` to send voice/video/file, or to send images to a specific conversation/in a composed API message. For example:

{"action":"send_group_msg","params":{"group_id":"123","message":[{"type":"image","data":{"file":"resource:avatar"}}]}}

You may also pass a local absolute path, a \`file://\` URI, an HTTP(S) URL or \`base64://\` content directly. Files exported by MCP use \`mcp://<server name>/<sandbox-relative path>\` or an already-resolved accessible URL. Do not pass only the user-visible file name unless that name is itself a \`resource:\` reference.

## 5. Differences between images, voice, video and files
- Sending images/voice/video as message content: use \`send_private_msg\` / \`send_group_msg\` and put the corresponding segment into \`message\`.
- Uploading a file to the group file area or private-chat file area: use \`upload_group_file\` / \`upload_private_file\`, for example:
  \`{"action":"upload_group_file","params":{"group_id":"123","file":"/data/a.zip","name":"a.zip"}}\`.
- The \`file\` of upload actions also accepts \`resource:<resource ID>\`; the tool first resolves it to the configured resource's real path and then hands it to the file upload API.
- The \`file\` message segment is a file card inside a message and is not the same as \`upload_group_file\`; do not use an ordinary \`file\` segment to fake a group-file-area upload.
- Voice generation is an **asynchronous task**: \`generate_audio\` only submits the task and immediately returns a task number; it does not produce a segment on the spot. When generation finishes the system notifies you of the result (including a local file path or URL), and you should then give the record segment (\`{"type":"record","data":{"file":"<path or URL>"}}\`) to \`call_ob11_api\` to send. **Note: \`[audio:xxx]\` in a reply only recognizes local voice resource names configured on the "Resources" page and does not accept arbitrary file paths/URLs**, so generated results must go through a record segment. Query queue status with \`media_tasks\`.
- Voice/images can also be triggered directly by the user with \`.ai tts\` / \`.ai tti\`; that path is delivered by the plugin directly and needs no tool involvement.

### 5.1 Protocol-side built-in AI voice (a different pipeline from the plugin's TTS)

The protocol side (NapCat / Lagrange, etc.) implements "AI voice" itself and **needs no model configured in the plugin**; call its extension APIs directly with \`call_ob11_api\`:

- First look up available characters: \`{"action":"get_ai_characters","params":{"group_id":"<group number>","chat_type":1}}\` → \`data[].characters[]\`, each item containing \`character_id\` (character ID), \`character_name\` (character name) and \`preview_url\` (preview).
- Send directly to a group: \`{"action":"send_group_ai_record","params":{"character":"<character ID>","group_id":"<group number>","text":"<text to speak>"}}\` → returns \`data.message_id\`. This is an **asynchronous/slow** API; on failure judge by retcode (1400 invalid params / 1401 insufficient permission / 1404 resource not found).
- Only get the voice without sending: \`{"action":"get_ai_record","params":{"character":"<character ID>","group_id":"<group number>","text":"<text to speak>"}}\` → \`data\` is the voice URL (silk); you then decide how to send it.
- For private chats use \`send_private_ai_record\` with the same parameter shape (\`group_id\` replaced by the corresponding conversation parameter as required by the protocol side).
- **\`character\` requires the character ID** (\`character_id\`, e.g. the form \`ai_char_1\`), not the Chinese character name; when unsure, call \`get_ai_characters\` first instead of making one up from memory.
- Common character names (\`character_name\`, **for reference only**; what \`get_ai_characters\` returns is authoritative): ${PROTOCOL_AI_VOICE_CHARACTERS.join(', ')}.
- Distinguished from the plugin's \`generate_audio\` / \`.ai tts\`: that pipeline uses the api connection on the "Models" page plus the model rule's \`tts\` purpose (Alibaba CosyVoice, SiliconFlow, OpenAI or self-hosted TTS) and the voice is configured in the model rule; this section's pipeline uses protocol-side capabilities and the two do not affect each other. When the protocol side does not support these actions (some implementations only support group chats / have not enabled AI voice), it returns a retcode or \`OB11_DEPENDENCY_REQUIRED\`; in that case fall back to \`generate_audio\`.
- For music search, first use \`search_music\` to get a music segment, then put that segment into the send action; do not send it directly, keep using \`call_ob11_api\`.

## 6. JSON, Markdown and music
- JSON: \`{"type":"json","data":{"data":"<JSON string>"}}\`. Keep the JSON string valid; when the protocol side does not support it the tool returns a failure — do not change it into plain text on your own.
- Markdown: \`{"type":"markdown","data":{"content":"# Title\\nBody"}}\` or use the \`data\` field as required by the protocol side.
- QQ Music: \`{"type":"music","data":{"type":"qq","id":"<song ID>"}}\`.
- NetEase Cloud Music: \`{"type":"music","data":{"type":"163","id":"<song ID>"}}\`.
- Custom music: \`{"type":"music","data":{"type":"custom","url":"<display page>","audio":"<audio URL>","title":"<title>","content":"<artist/description>","image":"<cover URL>"}}\`.
- JSON/Markdown/music are protocol-side special messages; do not disguise them as ordinary text when the required dependency is missing.

## 7. Forwarded messages
- With an existing forwarded-message ID: use \`{"type":"forward","data":{"id":"<forward ID>"}}\` inside \`message\` (native SealDice can only best-effort encode this reference).
- To build a new forwarded message: use \`send_group_forward_msg\` or \`send_private_forward_msg\` and provide nodes in the \`messages\` / \`messages\` node format of the current protocol side; such remote actions require the ob11 network-connection dependency.
- node example: \`{"type":"node","data":{"user_id":"10001","nickname":"nickname","content":[{"type":"text","data":{"text":"content"}}]}}\`. Protocol sides may differ in node fields; prefer the current endpoint's documentation.

## 8. action collection (three layers)
\`call_ob11_api\` takes OneBot 11 (OB11) action names as its entry point and adds no wrapper names. Current endpoint capabilities fall into three layers, all passed through under their original names:

### 8.1 OB11 standard actions (38, common to compatible endpoints)
- Messages: \`send_private_msg\`, \`send_group_msg\`, \`send_msg\`, \`delete_msg\`, \`get_msg\`, \`get_forward_msg\`, \`send_like\`
- Group management: \`set_group_kick\`, \`set_group_ban\`, \`set_group_anonymous_ban\`, \`set_group_whole_ban\`, \`set_group_admin\`, \`set_group_anonymous\`, \`set_group_card\`, \`set_group_name\`, \`set_group_leave\`, \`set_group_special_title\`
- Requests: \`set_friend_add_request\`, \`set_group_add_request\`
- Queries: \`get_login_info\`, \`get_stranger_info\`, \`get_friend_list\`, \`get_group_info\`, \`get_group_list\`, \`get_group_member_info\`, \`get_group_member_list\`, \`get_group_honor_info\`
- Account/tools: \`get_cookies\`, \`get_csrf_token\`, \`get_credentials\`, \`get_record\`, \`get_image\`, \`can_send_image\`, \`can_send_record\`, \`get_status\`, \`get_version_info\`, \`set_restart\`, \`clean_cache\`

### 8.2 NapCat/compatible endpoint extensions (128, passed through as-is)
When the ob11 network-connection dependency is installed, extension actions of endpoints such as NapCat are also passed through under their original names. Common examples:
- Message extensions: \`send_group_forward_msg\`, \`send_private_forward_msg\`, \`send_forward_msg\`, \`set_essence_msg\`, \`delete_essence_msg\`, \`get_essence_msg_list\`, \`set_msg_emoji_like\`, \`get_group_msg_history\`, \`get_friend_msg_history\`, \`get_ai_record\`, \`send_group_ai_record\`, \`send_private_ai_record\`
- Group files: \`upload_group_file\`, \`upload_private_file\`, \`get_group_file_url\`, \`get_group_root_files\`, \`get_group_files_by_folder\`, \`create_group_file_folder\`, \`delete_group_file\`, \`delete_group_folder\`, \`move_group_file\`, \`rename_group_file\`, \`get_private_file_url\`, \`get_group_file_system_info\`, \`trans_group_file\`
- Group management extensions: \`set_group_portrait\`, \`set_group_remark\`, \`set_group_member_invite_policy\`, \`set_group_member_permissions\`, \`set_group_new_member_history_visibility\`, \`set_group_kick_members\`, \`get_group_system_msg\`, \`get_group_shut_list\`, \`send_group_sign\`, \`set_group_sign\`, \`get_group_at_all_remain\`, \`_send_group_notice\`, \`_get_group_notice\`, \`_del_group_notice\`
- Avatar/profile/status: \`set_qq_avatar\`, \`set_qq_profile\`, \`set_self_longnick\`, \`set_online_status\`, \`set_diy_online_status\`, \`get_online_clients\`, \`get_robot_uin_range\`, \`get_clientkey\`, \`get_rkey\`, \`get_rkey_server\`, \`nc_get_rkey\`, \`nc_get_packet_status\`, \`nc_get_user_status\`
- Poke/emoji/favorites: \`group_poke\`, \`friend_poke\`, \`send_poke\`, \`fetch_custom_face\`, \`fetch_custom_face_detail\`, \`add_custom_face\`, \`delete_custom_face\`, \`set_custom_face_desc\`, \`fetch_emoji_like\`, \`get_emoji_likes\`, \`create_collection\`, \`get_collection_list\`
- Forward/translate/OCR/keyboard: \`forward_friend_single_msg\`, \`forward_group_single_msg\`, \`translate_en2zh\`, \`fetch_ptt_text\`, \`ocr_image\`, \`click_inline_keyboard_button\`
- Flash messages/online files/Qzone: \`send_flash_msg\`, \`create_flash_task\`, \`get_flash_file_list\`, \`get_flash_file_url\`, \`get_fileset_id\`, \`get_fileset_info\`, \`download_fileset\`, \`send_online_file\`, \`send_online_folder\`, \`get_online_file_msg\`, \`receive_online_file\`, \`refuse_online_file\`, \`cancel_online_file\`, \`send_qzone_msg\`, \`delete_qzone_msg\`
- Others: \`delete_friend\`, \`mark_msg_as_read\`, \`mark_group_msg_as_read\`, \`mark_private_msg_as_read\`, \`_mark_all_as_read\`, \`get_recent_contact\`, \`get_unidirectional_friend_list\`, \`set_input_status\`, \`get_profile_like\`, \`get_group_ignore_add_request\`, \`get_group_ignored_notifies\`, \`send_packet\`, \`get_mini_app_ark\`, \`get_guild_list\`, \`get_guild_service_profile\`, \`get_share_link\`, \`download_file\`, \`check_url_safely\`, \`get_file\`, \`set_friend_remark\`, \`get_doubt_friends_add_request\`, \`set_doubt_friends_add_request\`, \`set_group_todo\`, \`complete_group_todo\`, \`cancel_group_todo\`, \`get_group_album_media_list\`, \`del_group_album_media\`, \`set_group_album_media_like\`, \`cancel_group_album_media_like\`, \`do_group_album_comment\`, \`upload_image_to_qun_album\`, \`get_qun_album_list\`, \`get_friends_with_category\`, \`get_group_info_ex\`, \`get_group_detail_info\`, \`get_group_signed_list\`
- **Unlisted actions are passed through as-is too**: call them as long as the endpoint supports them; provide params per the endpoint documentation — this tool does no conversion.

### 8.3 Legacy Milky method names (compatibility layer)
If the current endpoint uses the SealDice Milky compatibility layer (sealdice-plugin-ob11-net-connection), a batch of Milky-style method names is also accepted (\`get_impl_info\`, \`get_friend_info\`, \`get_user_profile\`, \`send_friend_nudge\`, \`send_group_nudge\`, \`set_group_member_mute\`, \`set_group_member_admin\`, \`set_group_member_card\`, \`set_group_avatar\`, \`set_avatar\` and about 39 in total); the dependency layer rewrites them into the corresponding OB11/NapCat actions automatically. Milky methods without an equivalent action (about 12, e.g. \`get_peer_pins\`, \`get_friend_requests\`, \`accept_friend_request\`) explicitly return unsupported. Prefer the original OB11 standard/NapCat extension names; use compatibility-layer methods only when needed.

## 9. Whether the ob11 dependency is installed
Every call checks \`globalThis.net\` at runtime; the user does not need to choose a backend manually:
- ob11 network-connection dependency installed: calls go through \`net.callApi\`; \`upload_*_file\` prefers the unified \`net.sendFile\`, preserving the endpoint's special file-upload implementation; all protocol actions, special messages, lists, management and remote forwarded messages work according to endpoint capability.
- Dependency not installed: the native SealDice backend still handles \`send_private_msg\`, \`send_group_msg\`, \`get_login_info\`, \`get_status\`, \`get_version_info\`, \`get_group_info\`, \`get_group_member_info\` and \`get_stranger_info\` within what the current context allows. Segments such as text, image, voice, video, file, at, reply, face, poke, dice, rps, music, json and markdown are best-effort converted into SealDice/CQ content; unsupported nodes or remote forwards are not silently dropped.
- Without the dependency, lists, history, recall, group management, group-file upload, remote forwarded messages and unknown actions return \`error.code="OB11_DEPENDENCY_REQUIRED"\`. Do not retry repeatedly; install the dependency first, or switch to an action the native backend can complete.
- If a native send returns \`NATIVE_ACTION_UNSUPPORTED\` / \`NATIVE_CONTEXT_UNAVAILABLE\`, the current context lacks the capability — it does not mean the protocol side succeeded.

## 10. Call discipline
1. Confirm the target scenario and IDs before assembling action/params.
2. When sending special messages use a segment array and keep the type and data fields; do not flatten it into text.
3. When you see \`OB11_DEPENDENCY_REQUIRED\`, stop retrying and clearly tell the user the dependency is missing.
4. When you see \`OB11_API_ERROR\`, decide from the error whether to retry; do not blindly repeat actions with side effects.
5. The legacy tools are fully removed; do not create aliases, compatibility calls, or assume the legacy tools are still available.`;
