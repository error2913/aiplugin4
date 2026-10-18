// 「联网」页：单个 JSON 配置（联网配置）。
//
// 解析策略（与模型配置 v5 一致）：
//   1. 读「联网配置」→ parseWebConfig（JSON + 结构校验，带 $.a.b 路径报错）
//   2. 文本为空 → 用「后端 → 联网搜索」合成 legacy SearXNG provider（升级不破坏现状）
//   3. 校验失败 → 整体拒绝并回退 legacy（不让插件因搜索配置崩掉）
//
// 海豹没有配置写入 API，因此不做自动迁移：升级用户的行为由 legacy 合成保证。

import Logger from '../../logger';
import { defaultWebDefaults, legacySearxngProvider, parseWebConfig } from '../../web/schema';
import { WebConfig } from '../../web/types';
import { ext } from '../config';

const CONFIG_KEY = '联网配置';
const LEGACY_KEY = '联网搜索';
const CONFIG_GROUP = '联网';

let cache: WebConfig | null = null;

/** 仅供单元测试：清空模块级缓存 */
export function resetWebConfigCacheForTest(): void {
    cache = null;
}

function readStringConfig(key: string): string {
    try {
        return seal.ext.getStringConfig(ext, key) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${key}」失败: ${e instanceof Error ? e.message : String(e)}`);
        return '';
    }
}

function legacyConfig(): WebConfig {
    const legacyUrl = readStringConfig(LEGACY_KEY);
    const provider = legacySearxngProvider(legacyUrl);
    return {
        version: 1,
        defaults: defaultWebDefaults(),
        providers: [provider],
        routes: { search: [provider.id] },
    };
}

function buildConfig(): WebConfig {
    const text = readStringConfig(CONFIG_KEY);
    if (!text.trim()) {
        // 未配置新 JSON：沿用旧「联网搜索」地址，保证升级后 web_search 行为不变
        return legacyConfig();
    }

    const { config, issues } = parseWebConfig(text);
    if (config) return config;

    Logger.error(`「${CONFIG_KEY}」校验失败（共 ${issues.length} 处），本次不生效，已回退 legacy SearXNG：`);
    for (const issue of issues) Logger.error(`  ${issue.path} ${issue.msg}`);
    Logger.error('提示：可用配置生成器 https://error2913.github.io/aiplugin4-config/ 的「联网搜索」页生成后粘贴。');
    return legacyConfig();
}

export default class WebConfigStore {
    static register() {
        seal.ext.registerStringConfig(
            ext,
            CONFIG_KEY,
            '',
            '联网搜索/抓取配置（v1，一个 JSON）。留空 = 沿用「后端 → 联网搜索」的 SearXNG。'
            + '可配置 DeepSeek / SearXNG / Kimi / Brave / Tavily / Serper / 博查 / 智谱 / Exa / Firecrawl / 自定义 generic；'
            + '推荐用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/（「联网搜索」页）。修改后需重载 JS 生效。',
            CONFIG_GROUP,
        );
    }

    static get(): WebConfig {
        if (!cache) cache = buildConfig();
        return cache;
    }
}

export { CONFIG_KEY as WEB_CONFIG_KEY, LEGACY_KEY as WEB_LEGACY_KEY };
