// 知识库配置（独立「知识库」页签）：开关 + 整份 JSON（v1）。
//
// 新键名 `知识库配置`；旧的模板键 `知识库` 不再注册/读取（不做迁移）。
import Logger from "../../logger";
import { ext } from "../config";
import { DEFAULT_KB, DEFAULT_KB_JSON } from "../domain/defaults";
import { parseKbConfig } from "../domain/parse";
import { KbEntry } from "../domain/types";

export const KB_CONFIG_KEY = '知识库配置';

function fallbackLibraries(): KbEntry[] {
    return DEFAULT_KB.map(l => ({ ...l, platforms: [...l.platforms] }));
}

function readLibraries(): KbEntry[] {
    let text = '';
    try {
        text = seal.ext.getStringConfig(ext, KB_CONFIG_KEY) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${KB_CONFIG_KEY}」失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!text.trim()) {
        Logger.warning(`「${KB_CONFIG_KEY}」为空，已载入出厂知识库。`);
        return fallbackLibraries();
    }
    const result = parseKbConfig(text);
    for (const issue of result.issues) Logger.error(`  ${issue.path} ${issue.msg}`);
    for (const warning of result.warnings) Logger.warning(`  ${warning.path} ${warning.msg}`);
    if (!result.config) {
        Logger.error(`「${KB_CONFIG_KEY}」校验失败（共 ${result.issues.length} 处），本次按空知识库处理。`);
        Logger.error('提示：可用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/（「知识库」页）。');
        return [];
    }
    return result.config.libraries;
}

export default class KnowledgeBaseConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "启用知识库记忆", true, "开启后把知识库内容注入 system prompt，供对话参考", "知识库");
        seal.ext.registerStringConfig(
            ext,
            KB_CONFIG_KEY,
            DEFAULT_KB_JSON,
            '整份知识库配置（JSON v1）：{"version":1,"libraries":[{"name":"库名","description":"描述","platform":["QQ"],"content":"Markdown 正文"}]}。'
            + 'platform 省略或 [] = 所有平台；name 唯一。# 一级标题为条目、##/### 为小节，超长文档自动分块。'
            + '知识库为只读数据，AI 只能用 knowledge_search / knowledge_read / knowledge_list / knowledge_docs 检索。'
            + '推荐用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/（「知识库」页）。'
            + '修改后用 .ai kb refresh 生效（或重载 JS）。',
            '知识库',
        );
    }

    static get() {
        return {
            KNOWLEDGE: seal.ext.getBoolConfig(ext, "启用知识库记忆"),
            LIBRARIES: readLibraries(),
        }
    }
}

