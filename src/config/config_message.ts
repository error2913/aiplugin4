import { ConfigManager } from "./configManager";

export class MessageConfig {
    static ext: seal.ExtInfo;

    static register() {
        MessageConfig.ext = ConfigManager.getExt('aiplugin4_1:对话');

        seal.ext.registerTemplateConfig(MessageConfig.ext, "角色设定名称", [
            `默认设定`
        ], '按照豹语变量`$gSYSPROMPT`进行选择，与下面的角色设定对应')
        seal.ext.registerTemplateConfig(MessageConfig.ext, "角色设定", [
            `你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。`
        ], '')
        seal.ext.registerTemplateConfig(MessageConfig.ext, "system消息模板", [
            `你是一名QQ中的掷骰机器人，也称骰娘，用于线上TRPG中。你需要扮演以下角色在群聊和私聊中与人聊天。

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
        seal.ext.registerTemplateConfig(MessageConfig.ext, "示例对话", [""], "role顺序为user和assistant轮流出现");
        seal.ext.registerBoolConfig(MessageConfig.ext, "是否在消息内添加前缀", true, "可用于辨别不同用户");
        seal.ext.registerBoolConfig(MessageConfig.ext, "是否给AI展示数字号码", true, "例如QQ号和群号，能力较弱模型可能会出现幻觉");
        seal.ext.registerBoolConfig(MessageConfig.ext, "是否在消息内添加消息ID", false, "可用于撤回等情况");
        seal.ext.registerBoolConfig(MessageConfig.ext, "是否在消息内添加发送时间", false, "将消息发送时间添加到上下文中");
        seal.ext.registerBoolConfig(MessageConfig.ext, "是否合并user content", false, "在不支持连续多个role为user的情况下开启，可用于适配deepseek-reasoner");
        seal.ext.registerIntConfig(MessageConfig.ext, "存储上下文对话限制轮数", 15, "出现一次user视作一轮");
        seal.ext.registerIntConfig(MessageConfig.ext, "上下文插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，示例对话不计入轮数");

        seal.ext.registerBoolConfig(MessageConfig.ext, "是否启用上下文压缩", false, '');
        seal.ext.registerIntConfig(MessageConfig.ext, "每次压缩上下文条数", 10, '优先压缩最早的上下文');
        seal.ext.registerStringConfig(MessageConfig.ext, "上下文压缩 url地址", "", '为空时默认使用对话接口');
        seal.ext.registerStringConfig(MessageConfig.ext, "上下文压缩 API Key", "你的API Key", '若使用对话接口无需填写');
        seal.ext.registerTemplateConfig(MessageConfig.ext, "上下文压缩 body", [
            `"model":"deepseek-chat"`,
            `"max_tokens":1024`,
            `"stop":null`,
            `"stream":false`
        ], "messages不存在时，将会自动替换");
        seal.ext.registerTemplateConfig(MessageConfig.ext, "上下文压缩prompt模板", [
            `你是QQ群聊对话压缩助手。请将后续给出的历史消息压缩为可供后续继续对话的一段摘要。

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

## 输出要求
1. 保留人物关系、主要话题、关键事实、明确结论、未完成事项、后续约定。
2. 需要体现发言归属，避免把不同人的观点混淆。
3. 忽略闲聊、重复、噪声内容，但不要丢失约束信息。
4. 不要编造，不要解释，不要使用JSON，只输出摘要正文。`
        ], "");
    }

    static get() {
        return {
            roleSettingNames: seal.ext.getTemplateConfig(MessageConfig.ext, "角色设定名称"),
            roleSettingTemplate: seal.ext.getTemplateConfig(MessageConfig.ext, "角色设定"),
            systemMessageTemplate: ConfigManager.getHandlebarsTemplateConfig(MessageConfig.ext, "system消息模板"),
            samples: seal.ext.getTemplateConfig(MessageConfig.ext, "示例对话"),
            isPrefix: seal.ext.getBoolConfig(MessageConfig.ext, "是否在消息内添加前缀"),
            showNumber: seal.ext.getBoolConfig(MessageConfig.ext, "是否给AI展示数字号码"),
            showMsgId: seal.ext.getBoolConfig(MessageConfig.ext, "是否在消息内添加消息ID"),
            showTime: seal.ext.getBoolConfig(MessageConfig.ext, "是否在消息内添加发送时间"),
            isMerge: seal.ext.getBoolConfig(MessageConfig.ext, "是否合并user content"),
            maxRounds: seal.ext.getIntConfig(MessageConfig.ext, "存储上下文对话限制轮数"),
            insertCount: seal.ext.getIntConfig(MessageConfig.ext, "上下文插入system message间隔轮数"),
            isContextCompress: seal.ext.getBoolConfig(MessageConfig.ext, "是否启用上下文压缩"),
            contextCompressLength: seal.ext.getIntConfig(MessageConfig.ext, "每次压缩上下文条数"),
            contextCompressUrl: seal.ext.getStringConfig(MessageConfig.ext, "上下文压缩 url地址"),
            contextCompressApiKey: seal.ext.getStringConfig(MessageConfig.ext, "上下文压缩 API Key"),
            contextCompressBodyTemplate: seal.ext.getTemplateConfig(MessageConfig.ext, "上下文压缩 body"),
            contextCompressPromptTemplate: ConfigManager.getHandlebarsTemplateConfig(MessageConfig.ext, "上下文压缩prompt模板")
        }
    }
}
