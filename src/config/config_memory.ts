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
        seal.ext.registerStringConfig(MemoryConfig.ext, "记忆总结 url地址", "", '为空时，默认使用对话接口');
        seal.ext.registerStringConfig(MemoryConfig.ext, "记忆总结 API Key", "你的API Key", '若使用对话接口无需填写');
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "记忆总结 body", [
            `"model":"deepseek-chat"`,
            `"max_tokens":1024`,
            `"response_format": { "type": "json_object" }`,
            `"stop":null`,
            `"stream":false`
        ], "messages不存在时，将会自动替换");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "记忆总结prompt模板", [
            `你现在扮演的角色如下:
## 扮演详情
{{{角色设定}}}
            
## 聊天相关
    - 当前平台:{{{平台}}}
{{#if 私聊}}
    - 当前私聊:<{{{用户名称}}}>{{#if 展示号码}}({{{用户号码}}}){{/if}}
{{else}}
    - 当前群聊:<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}
    - <|at:xxx|>表示@某个群成员
    - <|poke:xxx|>表示戳一戳某个群成员
{{/if}}
{{#if 添加前缀}}
    - <|from:xxx|>表示消息来源，不要在生成的回复中使用
{{/if}}
{{#if 展示消息ID}}
    - <|msg_id:xxx|>表示消息ID，仅用于调用函数时使用，不要在生成的回复中提及或使用
    - <|quote:xxx|>表示引用消息，xxx为对应的消息ID
{{/if}}
{{#if 展示时间}}
    - <|time:xxxx-xx-xx xx:xx:xx|>表示消息发送时间，不要在生成的回复中提及或使用
{{/if}}
    - \\f用于分割多条消息

请根据你的设定，对以下对话内容进行总结:
{{{对话内容}}}

返回格式为JSON，格式类型如下:
{
    "content": {
        type: 'string',
        description: '总结后的对话摘要，请根据人物、行为、场景，以所扮演角色的口吻进行简短描述，只保留核心内容'
    },
    "memories": {
        type: 'array',
        description: '记忆数组。单条记忆应只有一个话题或事件。若对话内容对记忆有重要影响时返回，否则返回空数组',
        items: {
            type: 'object',
            description: '记忆对象',
            properties: {
                "memory_type": {
                    type: "string",
                    description: "记忆类型，个人或群聊。",
                    enum: ["private", "group"]
                },
                "name": {
                    type: 'string',
                    description: '用户名称或群聊名称{{#if 展示号码}}或纯数字QQ号、群号{{/if}}，实际使用时与记忆类型对应'
                },
                "keywords": {
                    type: 'array',
                    description: '记忆关键词',
                    items: {
                        type: 'string'
                    }
                },
                "content": {
                    type: 'string',
                    description: '记忆内容，尽量简短，无需附带时间与来源'
                }
            }
        }
    }
}`
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
            memoryUrl: seal.ext.getStringConfig(MemoryConfig.ext, "记忆总结 url地址"),
            memoryApiKey: seal.ext.getStringConfig(MemoryConfig.ext, "记忆总结 API Key"),
            memoryBodyTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "记忆总结 body"),
            memoryPromptTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "记忆总结prompt模板")
        }
    }
}