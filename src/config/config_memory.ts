import { ConfigManager } from "./config";

export class MemoryConfig {
    static ext: seal.ExtInfo;

    static register() {
        MemoryConfig.ext = ConfigManager.getExt('aiplugin4_7:记忆');

        seal.ext.registerBoolConfig(MemoryConfig.ext, "是否启用记忆", true, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆上限", 50, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆展示数量", 5, "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "记忆展示模板", [
            `{{#if 私聊}}
### 关于用户<{{{用户名称}}}>{{#if 展示号码}}({{{用户号码}}}){{/if}}:
{{else}}
### 关于群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}:
{{/if}}
    - 设定:{{{设定}}}
    - 记忆:
{{{记忆列表}}}`
        ], "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "单条记忆展示模板", [
            `   {{{序号}}}. 记忆ID:{{{记忆ID}}}
    时间:{{{记忆时间}}}
{{#if 个人记忆}}
    来源:{{#if 私聊}}私聊{{else}}群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}{{/if}}
{{/if}}
    关键词:{{{关键词}}}
    内容:{{{记忆内容}}}`
        ], "");
    }

    static get() {
        return {
            isMemory: seal.ext.getBoolConfig(MemoryConfig.ext, "是否启用记忆"),
            memoryLimit: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆上限"),
            memoryShowNumber: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆展示数量"),
            memoryShowTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "记忆展示模板"),
            memorySingleShowTemplate: seal.ext.getTemplateConfig(MemoryConfig.ext, "单条记忆展示模板")
        }
    }
}