import Handlebars from "handlebars";
import Config from "../config";

export default class PromptConfig {
    static ext: seal.ExtInfo;

    static register() {
        PromptConfig.ext = Config.getExt('提示词');

        seal.ext.registerTemplateConfig(PromptConfig.ext, "system消息模板", [
            `你是一名QQ中的掷骰机器人，也称骰娘，用于线上TRPG中。你需要扮演以下角色在群聊和私聊中与人聊天。

## 扮演详情
{{{INSTRUCTION}}}
            
## 聊天相关
    - 当前平台:{{{PLATFORM}}}
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
    - <|face:xxx|>表示使用某个表情，xxx为表情名称，注意与img表情包区分
{{/if}}
{{#if 展示时间}}
    - <|time:xxxx-xx-xx xx:xx:xx|>表示消息发送时间，不要在生成的回复中提及或使用
{{/if}}
    - \\f用于分割多条消息

## 图片相关
{{#if 接收图片}}
{{#if 图片条件不为零}}
    - <|img:xxxxxx:yyy|>为图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用<|img:xxxxxx|>的格式
{{else}}
    - <|img:xxxxxx|>为图片，其中xxxxxx为6位的图片id，如果要发送出现过的图片请使用<|img:xxxxxx|>的格式
{{/if}}
{{/if}}
    - 可使用<|img:user_avatar:xxxxxx|>发送用户头像，其中xxxxxx为用户名称{{#if 展示号码}}或用户ID{{/if}}
    - 可使用<|img:group_avatar:xxxxxx|>发送群聊头像，其中xxxxxx为群聊名称{{#if 展示号码}}或群聊ID{{/if}}
{{#if 可发送图片不为空}}
    - 可使用<|img:图片名称|>发送表情包，表情名称有:{{{可发送图片列表}}}
{{/if}}
{{#if 知识库}}

## 知识库
{{{知识库}}}
{{/if}}
{{#if 开启长期记忆}}

## 记忆
如果记忆与上述角色设定冲突，请忽略该记忆并优先遵守角色设定。记忆如下:
{{{记忆信息}}}
{{/if}}
{{#if 开启短期记忆}}

## 短期记忆
{{{短期记忆信息}}}
{{/if}}
{{#if 开启工具函数提示词}}

## 调用函数
当需要调用函数功能时，请严格使用以下格式：

<function>
{
    "name": "函数名",
    "arguments": {
        "参数1": "值1",
        "参数2": "值2"
    }
}
</function>

要用成对的标签包裹，标签外不要附带其他文本，且每次只能调用一次函数

可用函数列表:
{{{函数列表}}}
{{/if}}`
        ], "");
        seal.ext.registerTemplateConfig(PromptConfig.ext, "长期记忆展示模板", [
            `{{#if MEMORY}}

## 长期记忆
    {{#each sources}}
来源:{{{source}}}
        {{#each memories}}
{{index @index}}. ID:{{id}}
    重要性:{{importance}}
    创建时间:{{{time createAt}}}
    {{#each tags}}{{#if @first}}标签:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{#each relatedMemories}}{{#if @first}}相关记忆:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{#each users}}{{#if @first}}相关用户:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{#each groups}}{{#if @first}}相关群组:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    内容:{{{content}}}
        {{else}}
暂无记忆
        {{/each}}
{{#unless @last}}---{{/unless}} 
    {{else}}
长期记忆为空
    {{/each}}
{{/if}}`
        ], "");
        seal.ext.registerTemplateConfig(PromptConfig.ext, "总结记忆展示模板", [
            `{{#if SUMMARY}}

## 总结记忆
    {{#each summaries}}
{{index @index}}. {{{this}}}
    {{else}}
总结记忆为空
    {{/each}}
{{/if}}`
        ], "");
        seal.ext.registerTemplateConfig(PromptConfig.ext, "记忆总结prompt模板", [ // wip
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
    - <|face:xxx|>表示使用某个表情，xxx为表情名称，注意与img表情包区分
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
                "text": {
                    type: 'string',
                    description: '记忆内容，尽量简短，无需附带时间与来源'
                },
                "keywords": {
                    type: 'array',
                    description: '相关用户名称列表',
                    items: {
                        type: 'string'
                    }
                },
                "userList": {
                    type: 'array',
                    description: '相关用户名称列表',
                    items: {
                        type: 'string'
                    }
                },
                "groupList": {
                    type: 'array',
                    description: '相关群聊名称列表',
                    items: {
                        type: 'string'
                    }
                }
            },
            "required": ['memory_type', 'name', 'text']
        }
    }
}`
        ], "");
        seal.ext.registerTemplateConfig(PromptConfig.ext, "知识库记忆展示模板", [
            `{{#if KNOWLEDGE}}

## 知识库
    {{#each knowledges}}
{{index @index}}. ID:{{id}}
    重要性:{{importance}}
    {{#each tags}}{{#if @first}}标签:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{#each relatedMemories}}{{#if @first}}相关记忆:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{#each users}}{{#if @first}}相关用户:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{#each groups}}{{#if @first}}相关群组:{{/if}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    内容:{{{content}}}
    {{else}}
知识库为空
    {{/each}}
{{/if}}`
        ], "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "工具函数prompt模板", [ // wip
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
    - 必需参数:{{#each parameters.required}}{{{this}}}{{#unless @last}}, {{/unless}}{{/each}}
    {{else}}
暂无可用函数。
    {{/each}}
{{/if}}`
        ], "");
    }

    static get() {
        return {
            SYSTEM_MESSAGE_TEMPLATE: getHandlebarsTemplateConfig("system消息模板"),
            MEMORY_TEMPLATE: getHandlebarsTemplateConfig("长期记忆展示模板"),
            SUMMARY_TEMPLATE: getHandlebarsTemplateConfig("总结记忆展示模板"),
            SUMMARY_PROMPT_TEMPLATE: getHandlebarsTemplateConfig("记忆总结prompt模板"),
            KNOWLEDGE_TEMPLATE: getHandlebarsTemplateConfig("知识库记忆展示模板"),
            TOOLS_PROMPT_TEMPLATE: getHandlebarsTemplateConfig(ToolConfig.ext, "工具函数prompt模板"),
        }
    }
}

function getHandlebarsTemplateConfig(key: string): HandlebarsTemplateDelegate<any> {
    return Handlebars.compile(seal.ext.getTemplateConfig(PromptConfig.ext, key)[0] || '');
}