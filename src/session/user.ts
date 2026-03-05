import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";
import { MemoryService } from "./memory";
import { State } from "./session";

export class User {
    static validKeysMap: { [key in keyof User]?: TypeDescriptor<User[key]> } = {
        userId: 'string',
        userName: 'string',
        description: 'string',
        impression: 'string',
        state: 'any',
        memory: MemoryService
    }
    userId: string;
    userName: string;
    description: string;
    impression: string; // ai可修改的印象

    state: State; //储存状态信息
    memory: MemoryService;
}

export class UserManager {
    static userMap: { [key: string]: User };

    static getUser(userId: string): User {
        if (!this.userMap.hasOwnProperty(userId)) {
            let user = new User();
            try {
                const data = JSON.parse(ConfigManager.ext.storageGet(`user_${userId}`) || '{}');
                user = revive(User, data);
            } catch (error) {
                logger.error(`加载用户${userId}失败: ${error}`);
            }
            this.userMap[userId] = user;
        }
        return this.userMap[userId];
    }
}