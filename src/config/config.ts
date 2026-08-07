import Logger from "../logger";

import BackendConfig from "./configs/backend";
import BaseConfig from "./configs/base";
import ImageConfig from "./configs/image";
import MemoryConfig from "./configs/memory";
import MessageConfig from "./configs/message";
import ModelConfig from "./configs/model";
import PromptConfig from "./configs/prompt";
import ReceivedConfig from "./configs/received";
import ReplyConfig from "./configs/reply";
import ResourceConfig from "./configs/resource";
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
    model: ModelConfig,
    message: MessageConfig,
    received: ReceivedConfig,
    trigger: TriggerConfig,
    tool: ToolConfig,
    memory: MemoryConfig,
    image: ImageConfig,
    reply: ReplyConfig,
    backend: BackendConfig,
    base: BaseConfig,
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

export function getRegexConfig(ext: seal.ExtInfo, key: string): RegExp {
    const patterns = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pattern = patterns.join('|');
    if (pattern) {
        try {
            return new RegExp(pattern);
        } catch (e) {
            Logger.error(`正则表达式错误，内容:${pattern}，错误信息:${e instanceof Error ? e.message : String(e)}`);
            return /(?!)/;
        }
    }
    return /(?!)/;
}
