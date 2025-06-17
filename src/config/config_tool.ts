import { ConfigManager } from "./config";

export class ToolConfig {
    static ext: seal.ExtInfo;

    static register() {
        ToolConfig.ext = ConfigManager.getExt('aiplugin4_2:函数调用');

        seal.ext.registerBoolConfig(ToolConfig.ext, "是否开启调用函数功能", true, "");
        seal.ext.registerBoolConfig(ToolConfig.ext, "是否切换为提示词工程", false, "API在不支持function calling功能的时候开启");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "工具函数prompt模板", [
            `{{序号}}. 名称:{{{函数名称}}}
    - 描述:{{{函数描述}}}
    - 参数信息:{{{参数信息}}}
    - 必需参数:{{{必需参数}}}`
        ], "提示词工程中每个函数的prompt");
        seal.ext.registerIntConfig(ToolConfig.ext, "允许连续调用函数次数", 5, "单次对话中允许连续调用函数的次数");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "不允许调用的函数", [
            '在这里填写你不允许AI调用的函数名称'
        ], "修改后保存并重载js");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "默认关闭的函数", [
            'ban',
            'rename',
            'web_search',
            'check_list'
        ], "");
        seal.ext.registerBoolConfig(ToolConfig.ext, "是否启用记忆", true, "");
        seal.ext.registerIntConfig(ToolConfig.ext, "长期记忆上限", 5, "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "记忆展示模板", [
            `{{#if 私聊}}
### 关于用户<{{{用户名称}}}>{{#if 展示号码}}({{{用户号码}}}){{/if}}:
{{else}}
### 关于群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}:
{{/if}}
    - 设定:{{{设定}}}
    - 记忆:
{{{记忆列表}}}`
        ], "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "单条记忆展示模板", [
            `   {{{序号}}}. 时间:{{{记忆时间}}}
{{#if 个人记忆}}
    来源:{{#if 私聊}}私聊{{else}}群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}{{/if}}
{{/if}}
    内容:{{{记忆内容}}}`
        ], "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称", ["没有的话建议把draw_deck这个函数加入不允许调用"], "");
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
        seal.ext.registerTemplateConfig(ToolConfig.ext, "本地语音路径", ['data/records/钢管落地.mp3'], "如不需要可以不填写，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中");
    }

    static get() {
        return {
            isTool: seal.ext.getBoolConfig(ToolConfig.ext, "是否开启调用函数功能"),
            usePromptEngineering: seal.ext.getBoolConfig(ToolConfig.ext, "是否切换为提示词工程"),
            toolsPromptTemplate: seal.ext.getTemplateConfig(ToolConfig.ext, "工具函数prompt模板"),
            maxCallCount: seal.ext.getIntConfig(ToolConfig.ext, "允许连续调用函数次数"),
            toolsNotAllow: seal.ext.getTemplateConfig(ToolConfig.ext, "不允许调用的函数"),
            toolsDefaultClosed: seal.ext.getTemplateConfig(ToolConfig.ext, "默认关闭的函数"),
            isMemory: seal.ext.getBoolConfig(ToolConfig.ext, "是否启用记忆"),
            memoryLimit: seal.ext.getIntConfig(ToolConfig.ext, "长期记忆上限"),
            memoryShowTemplate: seal.ext.getTemplateConfig(ToolConfig.ext, "记忆展示模板"),
            memorySingleShowTemplate: seal.ext.getTemplateConfig(ToolConfig.ext, "单条记忆展示模板"),
            decks: seal.ext.getTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称"),
            character: seal.ext.getOptionConfig(ToolConfig.ext, "ai语音使用的音色"),
            recordPaths: seal.ext.getTemplateConfig(ToolConfig.ext, "本地语音路径")
        }
    }
}