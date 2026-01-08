import { ConfigManager } from "./config/configManager";
import { logger } from "./logger";
import { revive } from "./utils/utils";
import { fmtDate } from "./utils/utils_string";

export class BlockInfo {
    static validKeys: (keyof BlockInfo)[] = ['reason', 'time'];
    reason: string;
    time: number;

    constructor() {
        this.reason = '';
        this.time = 0;
    }
}

export class BlockManager {
    static blockList: { [id: string]: BlockInfo } = {};

    static initBlockList() {
        try {
            const data = JSON.parse(ConfigManager.ext.storageGet('blacklist') || '{}');
            if (typeof data !== 'object') throw new Error('blacklist不是对象');
            
            for (const key in data) {
                if (data.hasOwnProperty(key)) {
                    this.blockList[key] = revive(BlockInfo, data[key]);
                }
            }
        } catch (error) {
            logger.error(`从数据库中获取blacklist失败:`, error);
        }
    }

    static saveBlockList() {
        ConfigManager.ext.storageSet('blacklist', JSON.stringify(this.blockList));
    }

    static addBlock(id: string, reason: string) {
        const info = new BlockInfo();
        info.reason = reason;
        info.time = Date.now();
        
        this.blockList[id] = info;
        this.saveBlockList();
    }

    static removeBlock(id: string) {
        if (this.blockList.hasOwnProperty(id)) {
            delete this.blockList[id];
            this.saveBlockList();
            return true;
        }
        return false;
    }

    static checkBlock(id: string): string | null {
        if (this.blockList.hasOwnProperty(id)) {
            return this.blockList[id].reason;
        }
        return null;
    }

    static getListText(): string {
        const ids = Object.keys(this.blockList);
        if (ids.length === 0) {
            return '黑名单为空';
        }
        return ids.map(id => {
            const info = this.blockList[id];
            return `${id}: ${info.reason} (拉黑时间: ${fmtDate(Math.floor(info.time / 1000))})`;
        }).join('\n');
    }
}
