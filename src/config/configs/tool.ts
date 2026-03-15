import Config from "../config";

export default class ToolConfig {
    static ext: seal.ExtInfo;

    static register() {
        ToolConfig.ext = Config.getExt('工具');

        seal.ext.registerBoolConfig(ToolConfig.ext, "开启调用函数功能", true, "");
        seal.ext.registerBoolConfig(ToolConfig.ext, "切换为提示词工程", false, "API在不支持function calling功能的时候开启");
        seal.ext.registerIntConfig(ToolConfig.ext, "允许连续调用函数次数", 5, "单次对话中允许连续调用函数的次数");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "禁止调用的函数", [''], "修改后保存并重载js");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "默认关闭的函数", [''], "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称", [''], "没有的话建议把draw_deck这个函数加入不允许调用");
        seal.ext.registerOptionConfig(ToolConfig.ext, "ai语音使用的音色", '傲娇少女', [
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
        ], "该功能在选择预设音色时，需要安装http依赖插件，且需要可以调用ai语音api版本的napcat/lagrange等。选择自定义音色时，则需要aitts依赖插件和ffmpeg");
    }

    static get() {
        return {
            STATUS: seal.ext.getBoolConfig(ToolConfig.ext, "开启调用函数功能"),
            PROMPT_ENGINEERING: seal.ext.getBoolConfig(ToolConfig.ext, "切换为提示词工程"),
            MAX_CALL_COUNT: seal.ext.getIntConfig(ToolConfig.ext, "允许连续调用函数次数"),
            BLOCKED: seal.ext.getTemplateConfig(ToolConfig.ext, "禁止调用的函数"),
            DEFAULT_CLOSED: seal.ext.getTemplateConfig(ToolConfig.ext, "默认关闭的函数"),
            DECKS: seal.ext.getTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称"),
            TTS_CHARACTER: seal.ext.getOptionConfig(ToolConfig.ext, "ai语音使用的音色")
        }
    }
}