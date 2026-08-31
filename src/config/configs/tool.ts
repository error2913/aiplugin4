// 工具配置：函数调用开关/提示词工程/上限/禁用与默认关闭
import { ext } from "../config";
import { SEALDICE_COMMAND_WHITELIST } from "../static_config/sealdice_command_defaults";
// 音乐服务配置属于启动解析一次、重载 JS 才生效的复杂配置（JSON 逐行解析）：模块级缓存
let musicConfigCache: string[] | null = null;
function getMusicTemplateConfig(): string[] {
    if (musicConfigCache) return musicConfigCache;
    musicConfigCache = seal.ext.getTemplateConfig(ext, "音乐服务配置");
    return musicConfigCache;
}

export default class ToolConfig {
    static register() {

        seal.ext.registerBoolConfig(ext, "开启调用函数功能", true, "总开关；关闭后 AI 无法调用任何工具，仅保留普通对话", "工具");
        seal.ext.registerBoolConfig(ext, "切换为提示词工程", false, "API在不支持function calling功能的时候开启", "工具");
        seal.ext.registerBoolConfig(ext, "拉黑前需要骰主确认", true, "AI 建议拉黑时需骰主确认后才生效；关闭后 AI 可直接拉黑", "工具");
        seal.ext.registerBoolConfig(ext, "无工具调用时续跑提示", false, "上一轮调用过工具、本轮只回文字时，向上下文注入续跑提示再转一轮，避免只说方向不调用工具就停；默认关闭", "工具");
        seal.ext.registerBoolConfig(ext, "工具方向提示", true, "开启后要求模型调用工具前先向用户说一句方向说明，再在同一回复中给出工具调用块；关闭后直接调用工具，不播报方向", "工具");
        seal.ext.registerIntConfig(ext, "允许连续调用函数次数", 0, "单次回复流程中允许连续调用工具的次数，防止无限循环；0 为不限制", "工具");
        seal.ext.registerIntConfig(ext, "工具响应压缩触发字数", 10000, "工具返回结果超过该字数时压缩后再存入上下文；设为 0 不压缩", "工具");
        seal.ext.registerTemplateConfig(ext, "禁止调用的函数", [''], "每行一个禁止 AI 调用的函数名，示例：run_ext_command；扩展指令的细粒度控制请使用「可调用指令白名单」；修改后自动生效", "工具");
        seal.ext.registerTemplateConfig(ext, "默认关闭的函数", [''], "每行一个默认关闭的函数名，AI 默认无法调用；OB11 action 请使用下方 action 配置；修改后自动生效", "工具");
        seal.ext.registerTemplateConfig(ext, "禁止调用的 OB11 action", [''], "每行一个禁止 call_ob11_api 调用的原始 OB11 action，例如 set_group_ban；修改后自动生效", "工具");
        seal.ext.registerTemplateConfig(ext, "默认关闭的 OB11 action", [''], "每行一个默认关闭的原始 OB11 action，例如 get_group_member_list；关闭后 AI 不会调用，修改后自动生效", "工具");
        seal.ext.registerTemplateConfig(ext, "可调用指令白名单", SEALDICE_COMMAND_WHITELIST, "每行一个 AI 可调用的海豹指令；格式：扩展名|指令名/别名1/别名2，同一元素内的别名用 / 分隔；核心指令的扩展名统一写 core（如 core|roll/r/rd）。默认已包含当前 SealDice 源码中的全部核心命令、内置扩展命令及其别名；修改后自动生效", "工具");
        seal.ext.registerBoolConfig(ext, "是否允许调用所有指令", false, "开启后忽略白名单，允许调用所有可解析的扩展指令；核心指令仍通过 run_core_command 调用", "工具");
        seal.ext.registerStringConfig(ext, "指令前缀", ".", "注入到 SealDice 核心的指令前缀，通常为 .；如果核心改成其他前缀，请同步修改", "工具");
        seal.ext.registerTemplateConfig(ext, "音乐服务配置", [
            `{
    "platform": "网易云",
    "api": "http://net.ease.music.lovesealdice.online",
    "cookie": "_gid=GA1.2.2048499931.1737983161; _ga_MD3K4WETFE=GS1.1.1737983160.8.1.1737983827.0.0.0; _ga=GA1.1.1845263601.1736600307; MUSIC_U=00C10F470166570C36209E7E3E3649FEE210D3DB5B3C39C25214CFE5678DCC5773C63978903CEBA7BF4292B97ADADB566D96A055DCFDC860847761109F8986373FEC32BE2AFBF3DCFF015894EC61602562BF9D16AD12D76CED169C5052A470677A8D59F7B7D16D9FDE2A4ED237DE5C6956C0ED5F7A9EA151C3FA7367B0C6269FF7A74E6626B4D7F920D524718347659394CBB0DAE362991418070195FEFC730BCCE3CF4B03F24274075679FB4BFC884D099BD3CF679E4F1C9D5CBC2959CD29B0741BD52BCA155480116CE96393663B1A51D88AFDB57680F030CF93A305064A797B99874CA826D6760F616CB756B680591167AEE9AF31C4A187E61A19D7C1175961D4FE64CFD878F0BCEBB322A23E396DC5E8175A50D5E07B9788E4EBE8F8257FF139DB4FD03A89676F5C3DF1B70C101F4568C0A3657C24185218F975368ADB2DEF860760C59E9AFCCB214A4B51029E29ED; __csrf=85f3aa8cedc01f6d50b6b924efbf6f95; NMTID=00OG17oToz2Ne1rikTtgKPqOLaYuP0AAAGUqBEN0A"
}`,
            `{
    "platform": "qq",
    "api": "http://qqmusic.lovesealdice.online",
    "cookie": ""
}`
        ], "每行一条音乐服务配置，仅支持 JSON 格式：{\"platform\":\"网易云\",\"api\":\"域名\",\"cookie\":\"Cookie（可留空，网易云部分接口需要）\"}。platform 支持：网易云、qq。修改后需重载 JS 生效", "工具");
        seal.ext.registerOptionConfig(ext, "ai语音使用的音色", '傲娇少女', [
            "小新",
            "猴哥",
            "四郎",
            "东北老妹儿",
            "广西大表哥",
            "妲己",
            "霸道总裁",
            "酥心御姐",
            "说书先生",
            "憨憨小弟",
            "憨厚老哥",
            "吕布",
            "元气少女",
            "文艺少女",
            "磁性大叔",
            "邻家小妹",
            "低沉男声",
            "傲娇少女",
            "爹系男友",
            "暖心姐姐",
            "温柔妹妹",
            "书香少女",
            "自定义"
        ], "该功能在选择预设音色时，需要安装 http 依赖插件，且需要可调用 AI 语音 API 的 napcat/lagrange 等。\n选择自定义音色时，则需要生成音频依赖（tts）和 ffmpeg", "工具");
    }

    static get() {
        return {
            STATUS: seal.ext.getBoolConfig(ext, "开启调用函数功能"),
            PROMPT_ENGINEERING: seal.ext.getBoolConfig(ext, "切换为提示词工程"),
            BLOCK_REQUIRE_OWNER_CONFIRM: seal.ext.getBoolConfig(ext, "拉黑前需要骰主确认"),
            MAX_CALL_COUNT: seal.ext.getIntConfig(ext, "允许连续调用函数次数"),
            NUDGE_ENABLED: seal.ext.getBoolConfig(ext, "无工具调用时续跑提示"),
            DIRECTION_PROMPT: seal.ext.getBoolConfig(ext, "工具方向提示"),
            TOOL_RESPONSE_COMPRESS_MIN_LENGTH: seal.ext.getIntConfig(ext, "工具响应压缩触发字数"),
            BLOCKED: seal.ext.getTemplateConfig(ext, "禁止调用的函数"),
            DEFAULT_CLOSED: seal.ext.getTemplateConfig(ext, "默认关闭的函数"),
            OB11_BLOCKED_ACTIONS: seal.ext.getTemplateConfig(ext, "禁止调用的 OB11 action"),
            OB11_DEFAULT_CLOSED_ACTIONS: seal.ext.getTemplateConfig(ext, "默认关闭的 OB11 action"),
            CMD_WHITELIST: seal.ext.getTemplateConfig(ext, "可调用指令白名单"),
            ALLOW_ALL_CMDS: seal.ext.getBoolConfig(ext, "是否允许调用所有指令"),
            COMMAND_PREFIX: seal.ext.getStringConfig(ext, "指令前缀"),
            TTS_CHARACTER: seal.ext.getOptionConfig(ext, "ai语音使用的音色"),
            MUSIC: getMusicTemplateConfig()
        }
    }
}

