import { ConfigManager } from "./config";

export class MemoryConfig {
    static ext: seal.ExtInfo;

    static register() {
        MemoryConfig.ext = ConfigManager.getExt('aiplugin4_7:记忆');

        seal.ext.registerBoolConfig(MemoryConfig.ext, "是否启用长期记忆", true, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆上限", 50, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆展示数量", 5, "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "长期记忆展示模板", [
            `{{#if 私聊}}
### 关于用户<{{{用户名称}}}>{{#if 展示号码}}({{{用户号码}}}){{/if}}:
{{else}}
### 关于群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}:
{{/if}}
    - 设定:{{{设定}}}
    - 记忆:
{{{记忆列表}}}`
        ], "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "单条长期记忆展示模板", [
            `   {{{序号}}}. 记忆ID:{{{记忆ID}}}
    时间:{{{记忆时间}}}
{{#if 个人记忆}}
    来源:{{#if 私聊}}私聊{{else}}群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}{{/if}}
{{/if}}
    关键词:{{{关键词}}}
    内容:{{{记忆内容}}}`
        ], "");
        seal.ext.registerBoolConfig(MemoryConfig.ext, "是否启用短期记忆", true, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "短期记忆上限", 10, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "短期记忆总结轮数", 10, "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "记忆总结 body", [
            `"model":"deepseek-chat"`,
            `"max_tokens":1024`,
            `"response_format": { "type": "json_object" }`,
            `"stop":null`,
            `"stream":false`
        ], "messages不存在时，将会自动替换");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "记忆总结prompt模板", [
            `请对以下对话内容进行总结:

{{{对话内容}}}

返回格式为JSON，格式类型如下:
{
    "content": string,
    "importance": boolean,
    "keywords": string[]
}
content为总结后的对话摘要，请根据人物、行为、场景进行简短描述，只保留核心内容
若对话内容对记忆有重要影响，importance为true，keywords为对话内容中的关键词
若对话内容对记忆无重要影响，importance为false，keywords为空数组`
        ], "");
    }

    static get() {
        return {
            isMemory: seal.ext.getBoolConfig(MemoryConfig.ext, "是否启用长期记忆"),
            memoryLimit: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆上限"),
            memoryShowNumber: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆展示数量"),
            memoryShowTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "长期记忆展示模板"),
            memorySingleShowTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "单条长期记忆展示模板"),
            isShortMemory: seal.ext.getBoolConfig(MemoryConfig.ext, "是否启用短期记忆"),
            shortMemoryLimit: seal.ext.getIntConfig(MemoryConfig.ext, "短期记忆上限"),
            shortMemorySummaryRound: seal.ext.getIntConfig(MemoryConfig.ext, "短期记忆总结轮数"),
            memoryBodyTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "记忆总结 body"),
            memoryPromptTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "记忆总结prompt模板")
        }
    }
}