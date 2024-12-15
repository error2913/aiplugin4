import { ConfigManager } from "../utils/configUtils";
import { AI } from "./AI";

export class AIManager {
    static cache: { [key: string]: AI } = {};

    static clearCache() {
        this.cache = {};
    }

    static getAI(id: string) {
        if (!this.cache.hasOwnProperty(id)) {
            let data = {};

            try {
                data = JSON.parse(ConfigManager.ext.storageGet(`AI_${id}`) || '{}');
            } catch (error) {
                console.error(`从数据库中获取${`AI_${id}`}失败:`, error);
            }

            this.cache[id] = AI.parse(data, id);
        }

        return this.cache[id];
    }

    static saveAI(id: string) {
        if (this.cache.hasOwnProperty(id)) {
            ConfigManager.ext.storageSet(`AI_${id}`, JSON.stringify(this.cache[id]));
        }
    }
}