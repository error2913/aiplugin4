// 黑名单管理：按统一 ID（QQ:xxx / QQ-Group:xxx）拉黑用户或群，
// 命中时忽略其消息/指令/戳一戳，使其无法触发 AI
import { ext } from "./config/config";
import Logger from "./logger";
import { fmtDate } from "./utils/string";
import { revive, TypeDescriptor } from "./utils/utils";

export class BlockInfo {
    static validKeysMap: { [key in keyof BlockInfo]?: TypeDescriptor<BlockInfo[key]> } = {
        reason: 'string',
        time: 'number'
    };
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
            const data = JSON.parse(ext.storageGet('blacklist') || '{}');
            if (typeof data !== 'object' || Array.isArray(data)) throw new Error('blacklist不是对象');

            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    this.blockList[key] = revive(BlockInfo, data[key]);
                }
            }
        } catch (error) {
            Logger.error(`从数据库中获取blacklist失败:`, error);
        }
    }

    static saveBlockList() {
        ext.storageSet('blacklist', JSON.stringify(this.blockList));
    }

    static addBlock(id: string, reason: string) {
        const info = new BlockInfo();
        info.reason = reason;
        info.time = Date.now();

        this.blockList[id] = info;
        this.saveBlockList();
    }

    static removeBlock(id: string): boolean {
        if (Object.prototype.hasOwnProperty.call(this.blockList, id)) {
            delete this.blockList[id];
            this.saveBlockList();
            return true;
        }
        return false;
    }

    static checkBlock(id: string): string | null {
        if (Object.prototype.hasOwnProperty.call(this.blockList, id)) {
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
