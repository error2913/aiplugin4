import { MemoryItem } from "../../session/memory";
import { revive, TypeDescriptor } from "../../utils/utils";
import { Config, getHandlebarsTemplateConfig } from "../config";
import { load } from 'js-toml'

export default class MemoryConfig {
    static ext: seal.ExtInfo;

    static register() {
        MemoryConfig.ext = Config.getExt('aiplugin4:记忆');

        seal.ext.registerIntConfig(MemoryConfig.ext, "向量维度", 1024, "");
        seal.ext.registerBoolConfig(MemoryConfig.ext, "启用知识库记忆", false, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "知识库记忆展示数量", 10, "");
        seal.ext.registerBoolConfig(MemoryConfig.ext, "启用长期记忆", true, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆上限", 50, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆展示数量", 5, "");
        seal.ext.registerBoolConfig(MemoryConfig.ext, "启用总结记忆", true, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "总结记忆上限", 10, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "总结记忆间隔轮数", 10, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "总结记忆参与轮数", 10, "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "知识库记忆", [
            `# 采用toml进行格式化
roles = ["正确"] # 当数组为空或不存在时，默认对所有角色生效
            
[knowleges.测试]
content = """
这是内容
可以换行
"""
importance = 0.9 # 记忆重要性，0-1之间的浮点数，默认0.5
tags = ["标签1", "标签2"] # 标签列表
relatedMemories = ["测试2"] # 相关记忆ID列表
users = ["114514", "1919810"] # 相关用户ID列表
groups = ["114514", "1919810"] # 相关群组ID列表

[knowleges.测试2]
content = "单行形式，只有content字段是必须的"`
        ], "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "知识库记忆展示模板", [
            `{{#if KNOWLEGE}}

## 知识库
    {{#each knowleges}}
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
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "长期记忆展示模板", [
            `{{#if MEMORY}}

## 长期记忆
    {{#each sources}}
来源:{{{source}}}
        {{#each memories}}
{{index @index}}. ID:{{id}}
    重要性:{{importance}}
    创建时间:{{{createAt}}}
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
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "总结记忆展示模板", [
            `{{#if SUMMARY}}

## 总结记忆
    {{#each summaries}}
{{index @index}}. {{{this}}}
    {{else}}
总结记忆为空
    {{/each}}
{{/if}}`
        ], "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "记忆总结prompt模板", [ // wip
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
    }

    static get() {
        return {
            DIMENSION: seal.ext.getIntConfig(MemoryConfig.ext, "向量维度"),
            KNOWLEGE: seal.ext.getBoolConfig(MemoryConfig.ext, "启用知识库记忆"),
            KNOWLEGE_SHOW_NUMBER: seal.ext.getIntConfig(MemoryConfig.ext, "知识库记忆展示数量"),
            MEMORY: seal.ext.getBoolConfig(MemoryConfig.ext, "启用长期记忆"),
            MEMORY_LIMIT: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆上限"),
            MEMORY_SHOW_NUMBER: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆展示数量"),
            SUMMARY: seal.ext.getBoolConfig(MemoryConfig.ext, "启用总结记忆"),
            SUMMARY_LIMIT: seal.ext.getIntConfig(MemoryConfig.ext, "总结记忆上限"),
            SUMMARY_INTERVAL: seal.ext.getIntConfig(MemoryConfig.ext, "总结记忆间隔轮数"),
            SUMMARY_SIZE: seal.ext.getIntConfig(MemoryConfig.ext, "总结记忆参与轮数"),
            KNOWLEGE_MAPS: getKnowledgeMapsConfig(),
            KNOWLEGE_TEMPLATE: getHandlebarsTemplateConfig(MemoryConfig.ext, "知识库记忆展示模板"),
            MEMORY_TEMPLATE: getHandlebarsTemplateConfig(MemoryConfig.ext, "长期记忆展示模板"),
            SUMMARY_TEMPLATE: getHandlebarsTemplateConfig(MemoryConfig.ext, "总结记忆展示模板"),
            SUMMARY_PROMPT_TEMPLATE: getHandlebarsTemplateConfig(MemoryConfig.ext, "记忆总结prompt模板")
        }
    }
}

class KnowlegeConfigItem {
    static validKeysMap: { [key in keyof KnowlegeConfigItem]?: TypeDescriptor<KnowlegeConfigItem[key]> } = {
        roles: { array: 'string' },
        knowleges: {
            objectValue: {
                object: {
                    content: 'string',
                    importance: 'number',
                    tags: { array: 'string' },
                    relatedMemories: { array: 'string' },
                    users: { array: 'string' },
                    groups: { array: 'string' }
                }
            }
        }
    }
    roles: string[];
    knowleges: {
        [id: string]: {
            content: string,
            importance: number,
            tags: string[],
            relatedMemories: string[]
            users: string[],
            groups: string[]
        }
    }

    constructor() {
        this.roles = [];
        this.knowleges = {};
    }
}

interface KnowlegeMap {
    [id: string]: MemoryItem
}

function getKnowledgeMapsConfig(): { [role: string]: KnowlegeMap } {
    const tomlArray = seal.ext.getTemplateConfig(MemoryConfig.ext, "知识库记忆");
    const knowlegeConfigArray = tomlArray.map((tomlString) => revive(KnowlegeConfigItem, load(tomlString)));
    const knowlegeMaps: { [role: string]: KnowlegeMap } = {};
    for (const kc of knowlegeConfigArray) {
        const knowlegeMap: KnowlegeMap = {};
        for (const id in kc.knowleges) {
            const k = kc.knowleges[id];
            const m = new MemoryItem();
            m.id = id;
            m.importance = k.importance;
            m.content = k.content;
            m.tags = k.tags;
            m.relatedMemories = k.relatedMemories;
            m.users = k.users.map(u => String(u));
            m.groups = k.groups.map(g => String(g));
            knowlegeMap[id] = m;
        }
        if (kc.roles.length === 0) kc.roles.push('*');
        for (const role of kc.roles) {
            if (!knowlegeMaps.hasOwnProperty(role)) knowlegeMaps[role] = {};
            knowlegeMaps[role] = { ...knowlegeMaps[role], ...knowlegeMap };
        }
    }
    return knowlegeMaps;
}