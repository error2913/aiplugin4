import Handlebars from "handlebars";
import { logger } from "../logger";
import { AUTHOR, NAME, VERSION } from "./config";
import { BackendConfig } from "./config_backend";
import { ImageConfig } from "./config_image";
import { LogConfig } from "./config_log";
import { MemoryConfig } from "./config_memory";
import { MessageConfig } from "./config_message";
import { ReceivedConfig } from "./config_received";
import { ReplyConfig } from "./config_reply";
import { RequestConfig } from "./config_request";
import { ToolConfig } from "./config_tool";

export class ConfigManager {
    static ext: seal.ExtInfo;
    static cache: {
        [key: string]: {
            timestamp: number,
            data: any
        }
    } = {}

    static registerConfig() {
        this.ext = ConfigManager.getExt(NAME);
        LogConfig.register();
        RequestConfig.register();
        MessageConfig.register();
        ToolConfig.register();
        ReceivedConfig.register();
        ReplyConfig.register();
        ImageConfig.register();
        BackendConfig.register();
        MemoryConfig.register();
    }

    static getCache<T>(key: string, getFunc: () => T): T {
        const timestamp = Date.now()
        if (this.cache?.[key] && timestamp - this.cache[key].timestamp < 3000) {
            return this.cache[key].data;
        }

        const data = getFunc();
        this.cache[key] = {
            timestamp: timestamp,
            data: data
        }

        return data;
    }

    static get log() { return this.getCache('log', LogConfig.get) }
    static get request() { return this.getCache('request', RequestConfig.get) }
    static get message() { return this.getCache('message', MessageConfig.get) }
    static get tool() { return this.getCache('tool', ToolConfig.get) }
    static get received() { return this.getCache('received', ReceivedConfig.get) }
    static get reply() { return this.getCache('reply', ReplyConfig.get) }
    static get image() { return this.getCache('image', ImageConfig.get) }
    static get backend() { return this.getCache('backend', BackendConfig.get) }
    static get memory() { return this.getCache('memory', MemoryConfig.get) }

    static getExt(name: string): seal.ExtInfo {
        if (name == NAME && ConfigManager.ext) {
            return ConfigManager.ext;
        }

        let ext = seal.ext.find(name);
        if (!ext) {
            ext = seal.ext.new(name, AUTHOR, VERSION);
            seal.ext.register(ext);
        }

        return ext;
    }

    static getRegexConfig(ext: seal.ExtInfo, key: string): RegExp {
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

    static getRegexesConfig(ext: seal.ExtInfo, key: string): RegExp[] {
        return seal.ext.getTemplateConfig(ext, key).map(x => {
            try {
                return new RegExp(x);
            } catch (e) {
                logger.error(`正则表达式错误，内容:${x}，错误信息:${e.message}`);
                return /(?!)/;
            }
        });
    }

    static getHandlebarsTemplateConfig(ext: seal.ExtInfo, key: string): HandlebarsTemplateDelegate<any> {
        return Handlebars.compile(seal.ext.getTemplateConfig(ext, key)[0] || '');
    }

    static getHandlebarsTemplatesConfig(ext: seal.ExtInfo, key: string): HandlebarsTemplateDelegate<any>[] {
        return seal.ext.getTemplateConfig(ext, key).map(x => Handlebars.compile(x || ''));
    }

    static getPathMapConfig(ext: seal.ExtInfo, key: string): { [id: string]: string } {
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
}