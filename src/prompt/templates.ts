// 内置 prompt 模板：Handlebars 模板常量（不再注册为可配置项，避免用户误改导致渲染损坏）
import Handlebars from "handlebars";

import Logger from "../logger";

const TEMPLATES: { [key: string]: string } = {
    "system prompt模板": `你是一名QQ中的掷骰机器人，也称骰娘，用于线上TRPG中。你需要扮演以下角色在群聊和私聊中与人聊天。

## 扮演设定
{{{instruction}}}
            
## 聊天相关
- 平台:{{{platform}}}
- 会话类型:{{{sessionType}}}
- 会话名称:{{{sessionName}}}
- 会话ID:{{{sessionId}}}
- 当前时间:**CURRENT_TIME**

- [at:用户ID]表示@某个群成员，用户ID使用QQ号或规范化用户ID
- [poke:用户ID]表示戳一戳某个群成员，用户ID使用QQ号或规范化用户ID
- [from:xxx]表示消息来源，xxx为发送者名称，用户消息带此前缀（含QQ号）；同一发送者连续发言时仅首条带
- [msg_id:xxx]表示消息ID，xxx为对应消息的ID，引用某条消息时使用[quote:xxx]
- [time:xxxx-xx-xx xx:xx:xx]表示消息发送时间
- [from]/[msg_id]/[system]/[time] 是系统自动注入的上下文标记，聊天中禁止模仿或生成这些标签
- [quote:xxx]表示引用消息，xxx为对应的消息ID
- [face:xxx]表示使用某个表情，xxx为表情名称，注意与img表情包区分
- \\f用于分割多条消息

## 图片相关
{{#if RECEIVE_IMAGE}}
- [img:xxxxxx:yyy]表示图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用[img:xxxxxx]的格式
{{/if}}
- 可使用[avatar:用户ID]发送用户头像
- 可使用[group_avatar:群ID]发送群聊头像
- 可使用[img:图片ID]发送本地图片，可用名称先通过 list_resources(type=image) 查询

## OB11 消息与资源
- 所有协议消息只能使用 call_ob11_api：选择 send_private_msg/send_group_msg，并在 message 中传文本或消息段数组。
- 图片、语音、视频、文件使用 image/record/video/file 消息段；本地资源先用 list_resources 查询，再将 file 写成 resource:资源ID。
- 文件区上传使用 upload_group_file/upload_private_file，不要把上传动作伪装成普通 file 消息段。
- 资源路径支持本地绝对路径、file:// URI、HTTP(S) URL、base64://；MCP 沙箱文件使用 mcp://服务器名/沙箱相对路径。

**DYNAMIC_SECTIONS**

{{{toolPrompt}}}`,
    "长期记忆prompt模板": `{{#if MEMORY}}

## 长期记忆
    {{#each sources}}
        {{#each memories}}
{{index @index}}. [{{id}}] {{{content}}}
        {{else}}
暂无记忆
        {{/each}}
    {{else}}
长期记忆为空
    {{/each}}
{{/if}}`,
    "总结记忆prompt模板": `{{#if SUMMARY}}

## 总结记忆
    {{#each summaries}}
{{index @index}}. {{{this}}}
    {{else}}
总结记忆为空
    {{/each}}
{{/if}}`,
    "工具函数prompt模板": `{{#if PROMPT_ENGINEERING}}

## 调用函数
当需要调用函数功能时，请将函数调用数组放入以 \`\`\`function 开头、\`\`\` 结尾的代码块中，严格使用以下JSON格式，示例：

\`\`\`function
[
{
    "name": "函数名",
    "arguments": "{\\"参数1\\": \\"值1\\",\\"参数2\\": \\"值2\\"}"
}
]
\`\`\`

要使用成对的代码块围栏：\`\`\`function 在前面，\`\`\` 在后面包裹调用工具的数组。
可调用多个函数，每个调用需包含name字段和arguments字段，且arguments字段必须是JSON字符串。

可用函数列表:
    {{#each tools}}
{{index @index}}. 名称:{{{name}}}
    - 描述:{{{description}}}
    {{#if parameterText}}
    - 参数:{{{parameterText}}}
    {{/if}}
    {{else}}
暂无可用函数。
    {{/each}}
{{/if}}`,
    "图片识别prompt模板": "请帮我用简短的语言概括这张图片的特征，包括图片类型、场景、主题、主体等信息，如果有文字，请全部输出",
    "记忆总结prompt模板": `你现在扮演的角色如下:
## 扮演详情
{{{角色设定}}}
            
## 聊天相关
    - 当前平台:{{{平台}}}
{{#if 私聊}}
    - 当前私聊:<{{{用户名称}}}>({{{用户号码}}})
{{else}}
    - 当前群聊:<{{{群聊名称}}}>({{{群聊号码}}})
    - [at:用户ID]表示@某个群成员，用户ID使用QQ号或规范化用户ID
    - [poke:用户ID]表示戳一戳某个群成员，用户ID使用QQ号或规范化用户ID
    - [quote:xxx]表示引用消息，xxx为对应的消息ID
    - [face:xxx]表示使用某个表情，xxx为表情名称，注意与img表情包区分
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
        description: '记忆数组。单条记忆应只有一个话题或事件。若对话内容对记忆有重要影响时返回，否则返回空数组。除非用户明确要求记忆只在本会话中生效，否则不要传 visibility 字段（默认 public）',
        items: {
            type: 'object',
            description: '记忆对象',
            properties: {
                "memory_type": {
                    type: "string",
                    description: "记忆归属，个人或群聊，与可见性无关。",
                    enum: ["private", "group"]
                },
                "target_id": {
                    type: 'string',
                    description: '目标用户ID或群ID，实际使用时与记忆类型对应'
                },
                "text": {
                    type: 'string',
                    description: '记忆内容，尽量简短，无需附带时间与来源'
                },
                "keywords": {
                    type: 'array',
                    description: '相关关键词列表',
                    items: {
                        type: 'string'
                    }
                },
                "related_user_ids": {
                    type: 'array',
                    description: '相关用户ID列表',
                    items: {
                        type: 'string'
                    }
                },
                "related_group_ids": {
                    type: 'array',
                    description: '相关群ID列表',
                    items: {
                        type: 'string'
                    }
                },
                "visibility": {
                    type: "string",
                    description: "记忆可见性，仅当用户明确要求记忆只在本会话中生效时才传 private；其余情况不传（默认 public）",
                    enum: ["public", "private"]
                }
            },
            "required": ['memory_type', 'target_id', 'text']
        }
    }
}`
};

// 编译后的模板：模块加载即编译一次，渲染期异常不再兜底（避免掩盖模板 bug），由调用方自行处理
export const SYSTEM_MESSAGE_TEMPLATE = compileTemplate("system prompt模板");
export const MEMORY_TEMPLATE = compileTemplate("长期记忆prompt模板");
export const SUMMARY_TEMPLATE = compileTemplate("总结记忆prompt模板");
export const TOOLS_PROMPT_TEMPLATE = compileTemplate("工具函数prompt模板");
export const IMAGE_PROMPT_TEMPLATE = compileTemplate("图片识别prompt模板");
export const SUMMARY_PROMPT_TEMPLATE = compileTemplate("记忆总结prompt模板");

/** 编译内置模板：仅编译期（Handlebars.compile）失败时回退空函数，渲染期异常由调用方处理 */
function compileTemplate(key: string): HandlebarsTemplateDelegate<any> {
    try {
        return Handlebars.compile(TEMPLATES[key] || '');
    } catch (e) {
        Logger.error(`模板${key}解析失败: ${e instanceof Error ? e.message : String(e)}`);
        return () => '';
    }
}
