import Handlebars from "handlebars";
import { logger } from "../logger";
import { AUTHOR, CONFIG_CACHE_TTL, NAME, VERSION } from "./static_config";
import BaseConfig from "./configs/base";
import ModelConfig from "./configs/model";
import BackendConfig from "./configs/backend";
import ReceivedConfig from "./configs/received";
import TriggerConfig from "./configs/trigger";
import ImageConfig from "./configs/image";
import ToolConfig from "./configs/tool";
import MemoryConfig from "./configs/memory";

const configMap = {
    base: BaseConfig,
    model: ModelConfig,
    backend: BackendConfig,
    received: ReceivedConfig,
    trigger: TriggerConfig,
    image: ImageConfig,
    tool: ToolConfig,
    memory: MemoryConfig,
} as const;

type ConfigMap = typeof configMap;
type ConfigKey = keyof ConfigMap;
type ConfigProps = { [K in ConfigKey]: ReturnType<ConfigMap[K]["get"]> };
type ConfigProp = ConfigProps[ConfigKey];

interface ConfigCache {
    timestamp: number,
    data: ConfigProp
}

class Config {
    static ext: seal.ExtInfo;
    static cache: { [K in ConfigKey]?: ConfigCache } = {}

    static registerConfig() {
        this.ext = Config.getExt(NAME);
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
        if (name == NAME && Config.ext) {
            return Config.ext;
        }

        let ext = seal.ext.find(name);
        if (!ext) {
            ext = seal.ext.new(name, AUTHOR, VERSION);
            seal.ext.register(ext);
        }

        return ext;
    }
}

const _Config = Config as typeof Config & ConfigProps;
export { _Config as Config };

export function getRegexConfig(ext: seal.ExtInfo, key: string): RegExp {
    const patterns = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pattern = patterns.join('|');
    if (pattern) {
        try {
            return new RegExp(pattern);
        } catch (e) {
            logger.error(`正则表达式错误，内容:${pattern}，错误信息:${e.message}`);
            return /(?!)/;
        }
    }
    return /(?!)/;
}

export function getRegexesConfig(ext: seal.ExtInfo, key: string): RegExp[] {
    return seal.ext.getTemplateConfig(ext, key).map(x => {
        try {
            return new RegExp(x);
        } catch (e) {
            logger.error(`正则表达式错误，内容:${x}，错误信息:${e.message}`);
            return /(?!)/;
        }
    });
}

export function getHandlebarsTemplateConfig(ext: seal.ExtInfo, key: string): HandlebarsTemplateDelegate<any> {
    return Handlebars.compile(seal.ext.getTemplateConfig(ext, key)[0] || '');
}

export function getHandlebarsTemplatesConfig(ext: seal.ExtInfo, key: string): HandlebarsTemplateDelegate<any>[] {
    return seal.ext.getTemplateConfig(ext, key).map(x => Handlebars.compile(x || ''));
}

export function getPathMapConfig(ext: seal.ExtInfo, key: string): { [id: string]: string } {
    const paths = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pathMap: { [id: string]: string } = paths.reduce((acc: { [id: string]: string }, path: string) => {
        if (path.trim() === '') return acc;
        try {
            const id = path.split('/').pop().replace(/\.[^/.]+$/, '');
            if (!id) throw new Error(`本地路径格式错误:${path}`);
            acc[id] = path;
        } catch (e) {
            logger.error(`本地路径格式错误:${path}，错误信息:${e.message}`);
        }
        return acc;
    }, {});
    return pathMap;
}