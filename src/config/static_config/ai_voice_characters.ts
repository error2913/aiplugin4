// QQ 协议端（NapCat / Lagrange 等）自带的「AI 语音」角色名。
//
// 来源：v4.23 及以前「工具」页的「ai语音使用的音色」下拉选项。该下拉在 4.24.0 已删除，
// 原因是这条链路**不属于本插件的 TTS** —— 它由协议端自己实现，通过 OB11 扩展接口使用：
//   get_ai_characters      { group_id, chat_type }        → data[].characters[] { character_id, character_name, preview_url }
//   send_group_ai_record   { character, group_id, text }  → 直接把 AI 语音发到群（返回 data.message_id）
//   get_ai_record          { character, group_id, text }  → data = 语音 URL（silk），由调用方自行发送
//
// ⚠️ 两条完全不同的语音链路，别混：
//   1) 协议端自带 AI 语音（本文件）：骰主**不需要**配置任何模型，AI 用 `call_ob11_api` 调上面的 action 即可
//      （未收录的 action 由 capability_catalog 一律按 network 透传给协议端）。`character` 传角色 ID
//      （来自 get_ai_characters 的 character_id）。
//   2) 自建 TTS（阿里 CosyVoice / 硅基流动 / OpenAI 等）：走「模型」页 api连接 + 模型规则的 `tts` 用途，
//      音色在该规则 `[params].voice`（配合 `[body]` 里的 `{voice}` 占位符）里配置。
//   旧下拉里的「自定义」选项对应的正是第 2 条链路（当年需要额外的 tts 依赖 + ffmpeg），现已内置。
//
// 下表是各协议端常见的角色名（character_name），**仅作对照参考**；实际可用角色与 ID 以运行时
// get_ai_characters 的返回为准，不要当成写死的白名单。
export const PROTOCOL_AI_VOICE_CHARACTERS: string[] = [
    '小新',
    '猴哥',
    '四郎',
    '东北老妹儿',
    '广西大表哥',
    '妲己',
    '霸道总裁',
    '酥心御姐',
    '说书先生',
    '憨憨小弟',
    '憨厚老哥',
    '吕布',
    '元气少女',
    '文艺少女',
    '磁性大叔',
    '邻家小妹',
    '低沉男声',
    '傲娇少女',
    '爹系男友',
    '暖心姐姐',
    '温柔妹妹',
    '书香少女',
];
