import { ConfigManager } from "./config";

export class ToolConfig {
    static register() {
        seal.ext.registerBoolConfig(ConfigManager.ext, "是否开启调用函数功能", true, "");
        seal.ext.registerTemplateConfig(ConfigManager.ext, "允许调用的函数", [
            'memory',
            'draw_deck',
            'face',
            'jrrp',
            'modu_roll',
            'modu_search',
            'roll_check',
            'rename',
            'attr_show',
            'attr_get',
            'attr_set',
            'ban',
            'tts',
            'poke',
            'get_time',
            'set_timer',
            'web_search',
            'image_to_text',
            'san_check'
        ]);
        seal.ext.registerIntConfig(ConfigManager.ext, "长期记忆上限", 5, "");
        seal.ext.registerTemplateConfig(ConfigManager.ext, "提供给AI的牌堆名称", ["没有的话请去上面把draw_deck这个函数删掉"], "");
        seal.ext.registerOptionConfig(ConfigManager.ext, "ai语音使用的音色", '小新', [
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
            "书香少女"
        ], "需要http依赖，需要可以调用ai语音api版本的napcat/lagrange");
    }

    static get() {
        return {
            isTool: seal.ext.getBoolConfig(ConfigManager.ext, "是否开启调用函数功能"),
            toolsAllow: seal.ext.getTemplateConfig(ConfigManager.ext, "允许调用的函数"),
            memoryLimit: seal.ext.getIntConfig(ConfigManager.ext, "长期记忆上限"),
            decks: seal.ext.getTemplateConfig(ConfigManager.ext, "提供给AI的牌堆名称"),
            character: seal.ext.getOptionConfig(ConfigManager.ext, "ai语音使用的音色")
        }
    }
}