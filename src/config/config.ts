import Logger from "../logger";
import { AUTHOR, CONFIG_CACHE_TTL, NAME, VERSION } from "./static_config";
import BaseConfig from "./configs/base";
import ModelConfig from "./configs/model";
import BackendConfig from "./configs/backend";
import ReceivedConfig from "./configs/received";
import TriggerConfig from "./configs/trigger";
import ImageConfig from "./configs/image";
import ToolConfig from "./configs/tool";
import MemoryConfig from "./configs/memory";
import ReplyConfig from "./configs/reply";
import MessageConfig from "./configs/message";
import PromptConfig from "./configs/prompt";
import ResourceConfig from "./configs/resource";

const configMap = {
    base: BaseConfig,
    model: ModelConfig,
    backend: BackendConfig,
    received: ReceivedConfig,
    trigger: TriggerConfig,
    image: ImageConfig,
    tool: ToolConfig,
    memory: MemoryConfig,
    reply: ReplyConfig,
    message: MessageConfig,
    prompt: PromptConfig,
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
    static ext: seal.ExtInfo;
    static cache: { [K in ConfigKey]?: ConfigCache } = {}

    static registerConfig() {
        this.ext = this.getExt(NAME);
        for (const k of Object.keys(configMap) as ConfigKey[]) {
            configMap[k].register();
            Object.defineProperty(this, k, {
                get: () => this.getCache(k, configMap[k].get)
            })
        }
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

    static getExt(name: string): seal.ExtInfo {
        const n = `${NAME}:${name}`;
        let ext = seal.ext.find(n);
        if (!ext) {
            ext = seal.ext.new(n, AUTHOR, VERSION);
            seal.ext.register(ext);
        }
        return ext;
    }
}

const Config = _Config as typeof _Config & ConfigProps;
export default Config;

export function getRegexConfig(ext: seal.ExtInfo, key: string): RegExp {
    const patterns = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pattern = patterns.join('|');
    if (pattern) {
        try {
            return new RegExp(pattern);
        } catch (e) {
            Logger.error(`正则表达式错误，内容:${pattern}，错误信息:${e.message}`);
            return /(?!)/;
        }
    }
    return /(?!)/;
}