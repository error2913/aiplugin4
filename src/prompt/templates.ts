// 内置 prompt 模板：Handlebars 模板常量（不再注册为可配置项，避免用户误改导致渲染损坏）
import Handlebars from "handlebars";

import Logger from "../logger";

const TEMPLATES: { [key: string]: string } = {
    "system prompt模板": `你是骰娘机器人，按角色设定在私聊/群聊中扮演。

## 角色
{{{instruction}}}

## 会话信息
- 平台:{{{platform}}} | 类型:{{{sessionType}}} | 名称:{{{sessionName}}} | ID:{{{sessionId}}}
- 当前时间:**CURRENT_TIME**

## 消息标记
- [at:ID] @某人；[poke:ID] 戳一戳；[quote:ID] 引用；[face:名称] 表情
- [from:名字(QQ)] 发送者；[msg_id:ID] 消息ID；[time:时间] 发送时间
- [from]/[msg_id]/[system]/[time] 是系统自动注入标记，禁止模仿或生成
- \\f 表示多条消息分隔
{{#if RECEIVE_IMAGE}}
- [img:图片ID:描述] 图片；[avatar:用户ID] 头像；[group_avatar:群ID] 群头像
- 本地图片先用 list_resources(type=image) 查询
{{else}}
- [avatar:用户ID] 头像；[group_avatar:群ID] 群头像
{{/if}}

{{{toolPrompt}}}

**DYNAMIC_SECTIONS**`,
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
    "观察记忆prompt模板": `{{#if SUMMARY}}

## 观察记忆
    {{#each summaries}}
{{index @index}}. {{{this}}}
    {{else}}
观察记忆为空
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
    "记忆观察prompt模板": `你现在扮演的角色如下:
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

请根据你的设定，对以下对话内容进行观察:
{{{对话内容}}}

返回格式为JSON，格式类型如下（请严格返回合法的 JSON：所有键和字符串必须使用双引号，不要输出 Markdown 代码块或其他解释文字）:
{
    "summary": {
        "type": "string",
        "description": "一句话对话摘要，以所扮演角色的口吻简述本次对话的核心事件，只保留核心内容"
    },
    "facts": {
        "type": "array",
        "description": "记忆数组。每条一个原子事实或更新操作，一个话题/事件一条。若对话内容对记忆有重要影响时返回，否则返回空数组。除非用户明确要求记忆只在本会话中生效，否则不要传 visibility 字段（默认 public）",
        "items": {
            "type": "object",
            "description": "记忆操作对象",
            "properties": {
                "op": {
                    "type": "string",
                    "enum": ["add", "update", "delete", "noop"],
                    "description": "操作类型：新事实用 add；修正已存在的记忆（内容变化/错误）用 update 并附 existing_id；已过时/错误的记忆用 delete 并附 existing_id；其余情况用 noop（不写入）"
                },
                "existing_id": {
                    "type": "string",
                    "description": "op 为 update/delete 时必填：已存在记忆的 ID（来自长期记忆/观察记忆列表）"
                },
                "memory_type": {
                    "type": "string",
                    "description": "记忆归属，个人或群聊，与可见性无关。",
                    "enum": ["private", "group"]
                },
                "target_id": {
                    "type": "string",
                    "description": "目标用户ID或群ID，实际使用时与记忆类型对应"
                },
                "type": {
                    "type": "string",
                    "description": "记忆类型：fact（事实/偏好/属性）、rule（规则/群规/指令）、relation（人物关系）、event（发生过的事件）",
                    "enum": ["fact", "rule", "relation", "event"]
                },
                "text": {
                    "type": "string",
                    "description": "原子事实内容，一句话，尽量简短，无需附带时间与来源"
                },
                "keywords": {
                    "type": "array",
                    "description": "相关关键词/标签列表",
                    "items": {
                        "type": "string"
                    }
                },
                "related_user_ids": {
                    "type": "array",
                    "description": "相关用户ID列表",
                    "items": {
                        "type": "string"
                    }
                },
                "related_group_ids": {
                    "type": "array",
                    "description": "相关群ID列表",
                    "items": {
                        "type": "string"
                    }
                },
                "related_memory_ids": {
                    "type": "array",
                    "description": "相关联的已有记忆ID列表（来自长期记忆/观察记忆列表），用于建立记忆之间的关联",
                    "items": {
                        "type": "string"
                    }
                },
                "importance": {
                    "type": "number",
                    "description": "重要性 0-1：对角色塑造/长期关系/群规则重要给高分（≥0.8 会常驻注入），日常琐事给低分"
                },
                "visibility": {
                    "type": "string",
                    "description": "记忆可见性，仅当用户明确要求记忆只在本会话中生效时才传 private；其余情况不传（默认 public）",
                    "enum": ["public", "private"]
                }
            },
            "required": ["op", "text"]
        }
    }
}`
};

// 编译后的模板：模块加载即编译一次，渲染期异常不再兜底（避免掩盖模板 bug），由调用方自行处理
export const SYSTEM_MESSAGE_TEMPLATE = compileTemplate("system prompt模板");
export const MEMORY_TEMPLATE = compileTemplate("长期记忆prompt模板");
export const SUMMARY_TEMPLATE = compileTemplate("观察记忆prompt模板");
export const TOOLS_PROMPT_TEMPLATE = compileTemplate("工具函数prompt模板");
export const IMAGE_PROMPT_TEMPLATE = compileTemplate("图片识别prompt模板");
export const SUMMARY_PROMPT_TEMPLATE = compileTemplate("记忆观察prompt模板");

/** 编译内置模板：仅编译期（Handlebars.compile）失败时回退空函数，渲染期异常由调用方处理 */
function compileTemplate(key: string): HandlebarsTemplateDelegate<any> {
    try {
        return Handlebars.compile(TEMPLATES[key] || '');
    } catch (e) {
        Logger.error(`模板${key}解析失败: ${e instanceof Error ? e.message : String(e)}`);
        return () => '';
    }
}

