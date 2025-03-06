import { ConfigManager } from "./config";

export class ToolConfig {
    static ext: seal.ExtInfo;

    static register() {
        ToolConfig.ext = ConfigManager.getExt('aiplugin4_2:函数调用');

        seal.ext.registerBoolConfig(ToolConfig.ext, "是否开启调用函数功能", true, "");
        seal.ext.registerBoolConfig(ToolConfig.ext, "是否切换为提示词工程", false, "API在不支持function calling功能的时候开启");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "不允许调用的函数", [
            '在这里填写你不允许AI调用的函数名称'
        ], "修改后保存并重载js");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "默认关闭的函数", [
            'ban',
            'rename',
            'web_search',
            'check_list'
        ], "");
        seal.ext.registerIntConfig(ToolConfig.ext, "长期记忆上限", 5, "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称", ["没有的话请去上面把draw_deck这个函数删掉"], "");
        seal.ext.registerOptionConfig(ToolConfig.ext, "ai语音使用的音色", '小新', [
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
        seal.ext.registerTemplateConfig(ToolConfig.ext, "本地语音路径", ['<钢管落地>data/records/钢管落地.mp3'], "如不需要可以不填写，尖括号内是语音的名称，便于AI调用，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中");
    }

    static get() {
        return {
            isTool: seal.ext.getBoolConfig(ToolConfig.ext, "是否开启调用函数功能"),
            usePromptEngineering: seal.ext.getBoolConfig(ToolConfig.ext, "是否切换为提示词工程"),
            toolsNotAllow: seal.ext.getTemplateConfig(ToolConfig.ext, "不允许调用的函数"),
            toolsDefaultClosed: seal.ext.getTemplateConfig(ToolConfig.ext, "默认关闭的函数"),
            memoryLimit: seal.ext.getIntConfig(ToolConfig.ext, "长期记忆上限"),
            decks: seal.ext.getTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称"),
            character: seal.ext.getOptionConfig(ToolConfig.ext, "ai语音使用的音色"),
            recordsTemplate: seal.ext.getTemplateConfig(ToolConfig.ext, "本地语音路径")
        }
    }
}