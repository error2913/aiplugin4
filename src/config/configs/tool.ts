import { Config, getHandlebarsTemplateConfig, getPathMapConfig } from "../config";

export default class ToolConfig {
    static ext: seal.ExtInfo;

    static register() {
        ToolConfig.ext = Config.getExt('aiplugin4_2:函数调用');

        seal.ext.registerBoolConfig(ToolConfig.ext, "开启调用函数功能", true, "");
        seal.ext.registerBoolConfig(ToolConfig.ext, "切换为提示词工程", false, "API在不支持function calling功能的时候开启");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "工具函数prompt模板", [
            `{{#if PROMPT_ENGINEERING}}

## 调用函数
当需要调用函数功能时，请严格使用以下JSON格式，示例：

<function>
[
{
    "name": "函数名",
    "arguments": "{\\"参数1\\": \\"值1\\",\\"参数2\\": \\"值2\\"}"
}
]
</function>

要使用成对的标签：\`<function>\`在前面，\`</function>\`在后面包裹调用工具的数组。
可调用多个函数，每个调用需包含name字段和arguments字段，且arguments字段必须是JSON字符串。

可用函数列表:
{{#each tools}}
{{index @index}}. 名称:{{{name}}}
    - 描述:{{{description}}}
    - 参数信息:{{{json_stringify parameters.properties}}}
    - 必需参数:{{{string_array parameters.required}}}
{{else}}
    暂无可用函数。
{{/each}}
{{/if}}`
        ], "");
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
        seal.ext.registerTemplateConfig(ToolConfig.ext, "本地语音路径", ['data/records/钢管落地.mp3'], "如不需要可以不填写，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中");
    }

    static get() {
        return {
            STATUS: seal.ext.getBoolConfig(ToolConfig.ext, "开启调用函数功能"),
            PROMPT_ENGINEERING: seal.ext.getBoolConfig(ToolConfig.ext, "切换为提示词工程"),
            TOOLS_PROMPT_TEMPLATE: getHandlebarsTemplateConfig(ToolConfig.ext, "工具函数prompt模板"),
            MAX_CALL_COUNT: seal.ext.getIntConfig(ToolConfig.ext, "允许连续调用函数次数"),
            BLOCKED: seal.ext.getTemplateConfig(ToolConfig.ext, "禁止调用的函数"),
            DEFAULT_CLOSED: seal.ext.getTemplateConfig(ToolConfig.ext, "默认关闭的函数"),
            DECKS: seal.ext.getTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称"),
            CHARACTER: seal.ext.getOptionConfig(ToolConfig.ext, "ai语音使用的音色"),
            RECORD_PATH_MAP: getPathMapConfig(ToolConfig.ext, "本地语音路径")
        }
    }
}