// 「联网」页：一个 JSON（providers/routes）+ 5 个独立默认项配置。
//
// 解析策略（与模型配置 v5 一致）：
//   1. 读「联网配置」→ parseWebConfig（JSON + 结构校验，带 $.a.b 路径报错）
//   2. 文本为空 → 空配置（providers=[]；工具层提示去「联网」页配置）
//   3. 校验失败 → 整体拒绝 + 日志，同样落到空配置（不让插件因搜索配置崩掉）
//   4. 返回条数 / 详细程度 / 超时 / 正文截断 / 失败回退来自本页的独立配置项，
//      不再读 JSON 里的 defaults（旧字段忽略）。

import Logger from '../../logger';
import { normalizeWebDefaults, resolveWebConfig } from '../../web/schema';
import { WebConfig, WebDefaults } from '../../web/types';
import { ext } from '../ext';

import { GENERATOR_CONFIG_HINT } from './generator_hint';

const CONFIG_KEY = '联网配置';
const CONFIG_GROUP = '联网';

export const WEB_DEFAULTS_KEYS = {
    count: '联网搜索返回条数',
    detail: '联网搜索详细程度',
    timeout: '联网搜索超时',
    maxContentChars: '联网搜索正文截断',
    fallback: '联网搜索失败回退',
} as const;

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

/** 从「联网」页的 5 个独立配置项读取默认值（越界/非法回退默认） */
export function readWebDefaultsFromConfig(): WebDefaults {
    return normalizeWebDefaults({
        count: seal.ext.getIntConfig(ext, WEB_DEFAULTS_KEYS.count),
        detail: seal.ext.getOptionConfig(ext, WEB_DEFAULTS_KEYS.detail) as WebDefaults['detail'],
        timeout: seal.ext.getIntConfig(ext, WEB_DEFAULTS_KEYS.timeout),
        maxContentChars: seal.ext.getIntConfig(ext, WEB_DEFAULTS_KEYS.maxContentChars),
        fallback: seal.ext.getBoolConfig(ext, WEB_DEFAULTS_KEYS.fallback),
    });
}

function buildConfig(): WebConfig {
    const resolved = resolveWebConfig(readStringConfig(CONFIG_KEY));
    if (resolved.issues.length > 0) {
        Logger.error(`「${CONFIG_KEY}」校验失败（共 ${resolved.issues.length} 处），本次不生效：`);
        for (const issue of resolved.issues) Logger.error(`  ${issue.path} ${issue.msg}`);
        Logger.error('提示：可用配置生成器 https://error2913.github.io/aiplugin4-config/ 的「联网搜索」页生成后粘贴。');
    }
    // 默认项来自独立配置项（不写进联网 JSON）
    return { ...resolved.config, defaults: readWebDefaultsFromConfig() };
}

export default class WebConfigStore {
    static register() {
        seal.ext.registerStringConfig(
            ext,
            CONFIG_KEY,
            '',
            GENERATOR_CONFIG_HINT,
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(ext, WEB_DEFAULTS_KEYS.count, 10, '联网搜索默认返回条数（1~50）；工具调用未指定 count 时使用', CONFIG_GROUP);
        seal.ext.registerOptionConfig(ext, WEB_DEFAULTS_KEYS.detail, 'summary', ['snippet', 'summary', 'content'], '联网搜索默认详细程度：snippet 短摘要 / summary 长摘要 / content 正文；工具未指定时使用', CONFIG_GROUP);
        seal.ext.registerIntConfig(ext, WEB_DEFAULTS_KEYS.timeout, 20, '联网搜索/抓取单次请求默认超时（秒）；provider 自己的 timeout 优先', CONFIG_GROUP);
        seal.ext.registerIntConfig(ext, WEB_DEFAULTS_KEYS.maxContentChars, 5000, 'detail=content 时单条正文的最大字符数；超出截断', CONFIG_GROUP);
        seal.ext.registerBoolConfig(ext, WEB_DEFAULTS_KEYS.fallback, true, '请求失败时自动换下一个 provider；关闭后只试第一个，便于排障', CONFIG_GROUP);
    }

    static get(): WebConfig {
        if (!cache) cache = buildConfig();
        return cache;
    }
}

export { CONFIG_KEY as WEB_CONFIG_KEY };
