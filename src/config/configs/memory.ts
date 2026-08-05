// 记忆配置：向量维度/长期记忆/总结记忆/知识库 TOML
import { load } from 'js-toml'

import Logger from "../../logger";
import MemoryItem from "../../memory/memory_item";
import { revive, TypeDescriptor } from "../../utils/utils";
import { ext } from "../config";


export default class MemoryConfig {
    static register() {
        seal.ext.registerIntConfig(ext, "向量维度", 1024, "向量检索的维度，需与嵌入模型输出维度一致", "记忆");
        seal.ext.registerBoolConfig(ext, "启用长期记忆", true, "开启后对话内容会沉淀为长期记忆", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆上限", 50, "长期记忆条数上限，超出后按分数淘汰", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆展示数量", 5, "构造记忆 prompt 时展示的长期记忆条数", "记忆");
        seal.ext.registerBoolConfig(ext, "启用总结记忆", true, "开启后定期对对话进行总结记忆", "记忆");
        seal.ext.registerIntConfig(ext, "总结记忆上限", 10, "总结记忆条数上限", "记忆");
        seal.ext.registerIntConfig(ext, "总结记忆间隔轮数", 10, "每多少轮对话自动触发一次总结", "记忆");
        seal.ext.registerIntConfig(ext, "总结记忆参与轮数", 10, "每次总结纳入的对话轮数", "记忆");
        seal.ext.registerBoolConfig(ext, "启用知识库记忆", false, "开启后按角色加载知识库内容", "记忆");
        seal.ext.registerIntConfig(ext, "知识库记忆展示数量", 10, "知识库检索后写入 prompt 的条数", "记忆");
        seal.ext.registerTemplateConfig(ext, "知识库记忆", [
            `# 采用toml进行格式化
roles = [] # 当数组为空或不存在时，默认对所有角色生效
            
[knowledges.test]
content = """
这是内容
可以换行
"""
type = "text"
importance = 0.9 # 记忆重要性，0-1之间的浮点数，默认0.5
tags = ["标签1", "标签2"] # 标签列表
relatedMemories = ["test2"] # 相关记忆ID列表
users = ["114514", "1919810"] # 相关用户ID列表
groups = ["114514", "1919810"] # 相关群组ID列表

[knowledges.test2]
content = "单行形式，只有content字段是必须的"`
        ], "", "记忆");
    }

    static get() {
        return {
            DIMENSION: seal.ext.getIntConfig(ext, "向量维度"),
            MEMORY: seal.ext.getBoolConfig(ext, "启用长期记忆"),
            MEMORY_LIMIT: seal.ext.getIntConfig(ext, "长期记忆上限"),
            MEMORY_SHOW_NUMBER: seal.ext.getIntConfig(ext, "长期记忆展示数量"),
            SUMMARY: seal.ext.getBoolConfig(ext, "启用总结记忆"),
            SUMMARY_LIMIT: seal.ext.getIntConfig(ext, "总结记忆上限"),
            SUMMARY_INTERVAL: seal.ext.getIntConfig(ext, "总结记忆间隔轮数"),
            SUMMARY_SIZE: seal.ext.getIntConfig(ext, "总结记忆参与轮数"),
            KNOWLEDGE: seal.ext.getBoolConfig(ext, "启用知识库记忆"),
            KNOWLEDGE_SHOW_NUMBER: seal.ext.getIntConfig(ext, "知识库记忆展示数量"),
            KNOWLEDGE_MEMORIES_MAP: getKnowledgeMemoriesMapConfig()
        }
    }
}

class KnowledgeConfigItem {
    static validKeysMap: { [key in keyof KnowledgeConfigItem]?: TypeDescriptor<KnowledgeConfigItem[key]> } = {
        roles: { array: 'string' },
        knowledges: {
            objectValue: {
                object: {
                    content: 'string',
                    type: 'string',
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
    knowledges: {
        [id: string]: {
            content: string,
            type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'other',
            importance: number,
            tags: string[],
            relatedMemories: string[]
            users: string[],
            groups: string[]
        }
    }
    constructor() {
        this.roles = [];
        this.knowledges = {};
    }
}

function getKnowledgeMemoriesMapConfig(): { [role: string]: MemoryItem[] } {
    const knowledgeMaps: { [role: string]: { [id: string]: MemoryItem } } = {};
    seal.ext.getTemplateConfig(ext, "知识库记忆").forEach(tomlString => {
        let kc: KnowledgeConfigItem;
        try {
            kc = revive(KnowledgeConfigItem, load(tomlString));
        } catch (e) {
            Logger.error(`知识库记忆 TOML 解析失败，已跳过该条配置: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        const mmap: { [id: string]: MemoryItem } = {};
        for (const id in kc.knowledges) {
            const k = kc.knowledges[id];
            const m = new MemoryItem();
            m.id = id;
            m.importance = k.importance || 0.5;
            m.content = k.content;
            m.type = k.type || 'text';
            m.tags = k.tags || [];
            m.relatedMemories = k.relatedMemories || [];
            m.users = (k.users || []).map(u => String(u));
            m.groups = (k.groups || []).map(g => String(g));
            mmap[id] = m;
        }
        if (kc.roles.length === 0) kc.roles.push('*');
        for (const role of kc.roles) {
            if (!Object.prototype.hasOwnProperty.call(knowledgeMaps, role)) knowledgeMaps[role] = {};
            knowledgeMaps[role] = { ...knowledgeMaps[role], ...mmap };
        }
    });

    const knowledgeMemoriesMap: { [role: string]: MemoryItem[] } = {};
    for (const role of Object.keys(knowledgeMaps)) knowledgeMemoriesMap[role] = Object.values(knowledgeMaps[role]);
    return knowledgeMemoriesMap;
}
