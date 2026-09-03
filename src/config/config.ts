import Logger from "../logger";

import BackendConfig from "./configs/backend";
import BaseConfig from "./configs/base";
import ContextConfig from "./configs/context";
import ErrorConfig from "./configs/error";
import EventConfig from "./configs/event";
import ImageConfig from "./configs/image";
import KnowledgeBaseConfig from "./configs/knowledge_base";
import McpConfig from "./configs/mcp";
import MemoryConfig from "./configs/memory";
import ModelConfig from "./configs/model";
import ReceivedConfig from "./configs/received";
import ReplyConfig from "./configs/reply";
import ResourceConfig from "./configs/resource";
import RoleConfig from "./configs/role";
import SkillsConfig from "./configs/skills";
import ToolConfig from "./configs/tool";
import TriggerConfig from "./configs/trigger";
import { AUTHOR, CONFIG_CACHE_TTL, NAME, VERSION } from "./static_config";

export const ext: seal.ExtInfo = (() => {
    let e = seal.ext.find(NAME);
    if (!e) {
        e = seal.ext.new(NAME, AUTHOR, VERSION);
        seal.ext.register(e);
    }
    return e;
})();
const configMap = {
    base: BaseConfig,
    error: ErrorConfig,
    model: ModelConfig,
    role: RoleConfig,
    context: ContextConfig,
    received: ReceivedConfig,
    trigger: TriggerConfig,
    reply: ReplyConfig,
    tool: ToolConfig,
    mcp: McpConfig,
    skills: SkillsConfig,
    memory: MemoryConfig,
    knowledgeBase: KnowledgeBaseConfig,
    image: ImageConfig,
    backend: BackendConfig,
    event: EventConfig,
    resource: ResourceConfig,
} as const;

type ConfigMap = typeof configMap;
type ConfigKey = keyof ConfigMap;
type ConfigProps = { [K in ConfigKey]: ReturnType<ConfigMap[K]["get"]> };
type ConfigProp = ConfigProps[ConfigKey];

interface ConfigCache {
    timestamp: number,
    data: ConfigProp
}

class _Config {
    static cache: { [K in ConfigKey]?: ConfigCache } = {}

    static registerConfig() {
        for (const k of Object.keys(configMap) as ConfigKey[]) {
            configMap[k].register();
            Object.defineProperty(this, k, {
                get: () => this.getCache(k, configMap[k].get)
            })
        }
        // 预热模型配置，填充 Model 静态列表（Model.getChatModel 依赖）
        ModelConfig.get();
    }

    static getCache(key: ConfigKey, getFunc: () => ConfigProp): ConfigProp {
        const timestamp = Date.now()
        if (this.cache?.[key] && timestamp - this.cache[key].timestamp < CONFIG_CACHE_TTL) {
            return this.cache[key].data;
        }
        const data = getFunc();
        this.cache[key] = {
            timestamp: timestamp,
            data: data
        }
        return data;
    }

}

const Config = _Config as typeof _Config & ConfigProps;
export default Config;

// 正则配置属于启动解析一次、重载 JS 才生效的复杂配置：模块级缓存，重载 JS 后重新解析
const regexConfigCache: { [key: string]: RegExp } = {};
export function getRegexConfig(ext: seal.ExtInfo, key: string): RegExp {
    if (regexConfigCache[key]) return regexConfigCache[key];
    const patterns = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pattern = patterns.join('|');
    let regex: RegExp;
    if (pattern) {
        try {
            regex = new RegExp(pattern);
        } catch (e) {
            Logger.error(`正则表达式错误，内容:${pattern}，错误信息:${e instanceof Error ? e.message : String(e)}`);
            regex = /(?!)/;
        }
    } else {
        regex = /(?!)/;
    }
    regexConfigCache[key] = regex;
    return regex;
}
