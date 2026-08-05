// prompt 模板配置：system/记忆/总结/知识库/工具/图片识别等 Handlebars 模板
import Handlebars from "handlebars";

import Logger from "../../logger";
import { ext } from "../config";
export default class PromptConfig {
    static register() {
        seal.ext.registerTemplateConfig(ext, "system prompt模板", [
            `你是一名QQ中的掷骰机器人，也称骰娘，用于线上TRPG中。你需要扮演以下角色在群聊和私聊中与人聊天。

## 扮演设定
{{{instruction}}}
            
## 聊天相关
- 平台:{{{platform}}}
- 会话类型:{{{sessionType}}}
- 会话名称:{{{sessionName}}}
- 会话ID:{{{sessionId}}}

- <|at:xxx|>表示@某个群成员
- <|poke:xxx|>表示戳一戳某个群成员

## 特殊消息标签
- <|system:xxx|>表示系统消息，xxx为系统提示来源，不要在生成的回复中使用
- <|from:xxx|>表示消息来源，不要在生成的回复中使用
- <|msg_id:xxx|>表示消息ID，仅用于调用函数时使用，不要在生成的回复中提及或使用
- <|quote:xxx|>表示引用消息，xxx为对应的消息ID
- <|face:xxx|>表示使用某个表情，xxx为表情名称，注意与img表情包区分
- <|time:xxxx-xx-xx xx:xx:xx|>表示消息发送时间，不要在生成的回复中提及或使用
- \\f用于分割多条消息

## 图片相关
{{#if RECEIVE_IMAGE}}
- <|img:xxxxxx:yyy|>表示图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用<|img:xxxxxx|>的格式
{{/if}}
- 可使用<|img:user_avatar:xxxxxx|>发送用户头像，其中xxxxxx为用户名称或用户ID
- 可使用<|img:group_avatar:xxxxxx|>发送群聊头像，其中xxxxxx为群聊名称或群聊ID
{{#if LOCAL_IMAGES}}
- 可使用<|img:图片ID|>发送本地图片，本地图片列表如下：
    {{#each LOCAL_IMAGES}}
{{{imageId}}}{{unless @last}}、{{/unless}}
    {{else}}
暂无本地图片
    {{/each}}
{{/if}}

## 音频相关
{{#if LOCAL_AUDIOS}}
- 可使用<|audio:音频ID|>发送本地音频，本地音频列表如下：
    {{#each LOCAL_AUDIOS}}
{{{audioId}}}{{unless @last}}、{{/unless}}
    {{else}}
暂无本地音频
    {{/each}}
{{/if}}

{{{memoryPrompt}}}

{{{summaryPrompt}}}

{{{knowledgePrompt}}}

{{{toolPrompt}}}`
        ], "", "prompt模板");
        seal.ext.registerTemplateConfig(ext, "长期记忆prompt模板", [
            `{{#if MEMORY}}

## 长期记忆
    {{#each sources}}
来源:{{{source}}}
        {{#each memories}}
{{index @index}}. ID:{{id}}
    类型:{{type}}
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
        ], "", "prompt模板");
        seal.ext.registerTemplateConfig(ext, "总结记忆prompt模板", [
            `{{#if SUMMARY}}

## 总结记忆
    {{#each summaries}}
{{index @index}}. {{{this}}}
    {{else}}
总结记忆为空
    {{/each}}
{{/if}}`
        ], "", "prompt模板");
        seal.ext.registerTemplateConfig(ext, "知识库记忆prompt模板", [
            `{{#if KNOWLEDGE}}

## 知识库
    {{#each knowledges}}
{{index @index}}. ID:{{id}}
    类型:{{type}}
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
        ], "", "prompt模板");
        seal.ext.registerTemplateConfig(ext, "工具函数prompt模板", [ // 子智能体通过 call_subagent 工具暴露给 AI
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
        ], "", "prompt模板");
        seal.ext.registerTemplateConfig(ext, "图片识别prompt模板", ["请帮我用简短的语言概括这张图片的特征，包括图片类型、场景、主题、主体等信息，如果有文字，请全部输出"], "", "prompt模板");
        seal.ext.registerTemplateConfig(ext, "记忆总结prompt模板", [ // wip
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
        ], "", "prompt模板");
    }

    static get() {
        return {
            SYSTEM_MESSAGE_TEMPLATE: getHandlebarsTemplateConfig("system prompt模板"),
            MEMORY_TEMPLATE: getHandlebarsTemplateConfig("长期记忆prompt模板"),
            SUMMARY_TEMPLATE: getHandlebarsTemplateConfig("总结记忆prompt模板"),
            KNOWLEDGE_TEMPLATE: getHandlebarsTemplateConfig("知识库记忆prompt模板"),
            TOOLS_PROMPT_TEMPLATE: getHandlebarsTemplateConfig("工具函数prompt模板"),
            IMAGE_PROMPT_TEMPLATE: getHandlebarsTemplateConfig("图片识别prompt模板"),
            SUMMARY_PROMPT_TEMPLATE: getHandlebarsTemplateConfig("记忆总结prompt模板")
        }
    }
}

function getHandlebarsTemplateConfig(key: string): HandlebarsTemplateDelegate<any> {
    const template = seal.ext.getTemplateConfig(ext, key)[0] || '';
    try {
        return Handlebars.compile(template);
    } catch (e) {
        Logger.error(`模板${key}解析失败，已使用空模板: ${e.message}`);
        return () => '';
    }
}
